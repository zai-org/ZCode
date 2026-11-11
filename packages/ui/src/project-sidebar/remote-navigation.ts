import type {
  IProjectService,
  IRemoteProjectService,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";

/**
 * 同一设备在途的未指定目录连接。Host 把这类 connect 按设备复用为同一 logical session，
 * Renderer 也必须按 hostId 合并，才能让所有等待者共享同一个结果与释放责任。
 */
interface HostConnectionFlight {
  readonly sessionId: Promise<string>;
  waiters: number;
  claimed: boolean;
}

const hostConnectionFlights = new Map<string, HostConnectionFlight>();

function joinHostConnectionFlight(
  hostId: string,
  connect: () => Promise<string>,
): HostConnectionFlight {
  const current = hostConnectionFlights.get(hostId);
  if (current) {
    current.waiters += 1;
    return current;
  }
  const flight: HostConnectionFlight = { sessionId: connect(), waiters: 1, claimed: false };
  hostConnectionFlights.set(hostId, flight);
  return flight;
}

/** 不接管就退出；返回 true 表示自己是最后一个等待者且无人接管，需要释放这次连接。 */
function leaveHostConnectionFlight(hostId: string, flight: HostConnectionFlight): boolean {
  flight.waiters -= 1;
  if (flight.waiters > 0 || flight.claimed) return false;
  if (hostConnectionFlights.get(hostId) === flight) hostConnectionFlights.delete(hostId);
  return true;
}

/** 开始绑定目录即接管连接；之后恢复的等待者不能把同一 session 改绑到其他目录。 */
function claimHostConnectionFlight(hostId: string, flight: HostConnectionFlight): void {
  if (flight.claimed) throw new Error("project.navigation-cancelled");
  flight.claimed = true;
  flight.waiters -= 1;
  if (hostConnectionFlights.get(hostId) === flight) hostConnectionFlights.delete(hostId);
}

/** 连接实例归 Host；这里只申请/绑定 logical attachment，不按 path 复用另一台设备的 scope。 */
export async function attachRemoteProjectWorkspace(input: {
  hostId: string;
  workspacePath: string;
  workspaceIdentity: string;
  expectedMembershipId?: string;
  projectId?: string | null;
  projectService?: Pick<IProjectService, "readProjects">;
  remoteService: IRemoteProjectService;
  isCurrent?(): boolean;
  findSession(identity: string): { sessionId: string } | undefined;
  /** 等该目录在途的项目重连或 Source 可恢复断连结束；不在途时立即返回。 */
  waitForPendingConnection?(workspaceKey: string): Promise<void>;
  connect: ProjectSidebarProps["onConnectRemote"];
  bind(
    sessionId: string,
    path: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ): Promise<void>;
  cancel: ProjectSidebarProps["onCancelRemoteProject"];
}): Promise<string> {
  const assertCurrent = () => {
    if (input.isCurrent?.() === false) throw new Error("project.navigation-cancelled");
  };
  // Bug 原因：项目重连或 Source 恢复在途时 tab 还没有可用 owner，导航曾立即连接设备并另建连接，
  // 与重连争写 tab（ZCT-2117174788253970432），恢复期间还会抢先扩大恢复 flight。现在先等在途连接
  // 结束，再按当时的 owner 复用或自建；connectHost 可能让设备上线并触发项目重连，自建前再等一次。
  const settle = async () => {
    await input.waitForPendingConnection?.(input.workspaceIdentity);
    assertCurrent();
  };
  await settle();
  const host = await input.remoteService.connectHost(input.hostId);
  assertCurrent();
  const target = host.target;
  if (host.id !== input.hostId || !target) throw new Error("project.host-identity-changed");
  if (input.expectedMembershipId && host.membershipId !== input.expectedMembershipId)
    throw new Error("remote-project.host-removed");
  const validateMembership = async () => {
    if (input.expectedMembershipId) {
      const directory = await input.remoteService.readDirectory();
      if (
        !directory.hosts.some(
          (item) => item.id === input.hostId && item.membershipId === input.expectedMembershipId,
        )
      )
        throw new Error("remote-project.host-removed");
    }
    if (input.projectService && input.projectId) {
      const projects = await input.projectService.readProjects({ hostId: input.hostId });
      if (
        !projects.some(
          (project) =>
            project.id === input.projectId &&
            project.hostId === input.hostId &&
            !project.deleted &&
            project.roots.length === 1 &&
            project.roots[0]?.rootPath === input.workspacePath,
        )
      )
        throw new Error("project.not-found");
    }
    assertCurrent();
    return true;
  };
  // 连接和绑定都会等待远端；claim 在目录绑定前执行，标记本导航接管连接。
  const bindWorkspace = async (sessionId: string, claim?: () => void) => {
    assertCurrent();
    // Host 在连接等待中被移除再添加时，原请求不能借新成员的身份提交导航。
    const guard =
      input.expectedMembershipId || input.projectService ? validateMembership : input.isCurrent;
    if (guard === validateMembership) await validateMembership();
    claim?.();
    if (guard) await input.bind(sessionId, input.workspacePath, guard);
    else await input.bind(sessionId, input.workspacePath);
    // Bug 原因：bind 发现目录已有 tab owner（如 tab 重连与导航并发）时会复用它并回收本次连接，
    // 旧检查要求 owner 必须是本次 session，把成功复用误报为 workspace-identity-mismatch 并丢弃导航。
    // 现在只要求目录 identity 已落到某个 session（Host 绑定到其他 identity 时仍报错），并返回该 session。
    const bound = input.findSession(input.workspaceIdentity);
    if (!bound) throw new Error("project.workspace-identity-mismatch");
    return bound.sessionId;
  };

  // 目录已有 session 时只复用；失败也不能取消其他项目复用的连接。
  await settle();
  const existing = input.findSession(input.workspaceIdentity);
  if (existing) return await bindWorkspace(existing.sessionId);

  // Bug 原因：首连 Provisioning 可达十几秒，期间再次点击会再发一次 connect，Host 把它 join 到同一
  // session。旧逻辑把每次 connect 结果都当作“本次创建”，被替代的旧点击在连接迟到成功后立即释放，
  // 最新点击随之失败。现在按设备合并在途连接：被替代的等待者只退出，由接管者或最后一个等待者释放。
  const flight = joinHostConnectionFlight(input.hostId, () => input.connect(target));
  let sessionId: string;
  try {
    sessionId = await flight.sessionId;
  } catch (error) {
    leaveHostConnectionFlight(input.hostId, flight);
    throw error;
  }
  let claimed = false;
  try {
    return await bindWorkspace(sessionId, () => {
      claimHostConnectionFlight(input.hostId, flight);
      claimed = true;
    });
  } catch (error) {
    if (claimed || leaveHostConnectionFlight(input.hostId, flight)) await input.cancel(sessionId);
    throw error;
  }
}
