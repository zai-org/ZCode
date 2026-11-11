import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { execInRemoteContainer } from "#e2e/helpers/remote-docker-target";

// R7 远端环境重启的真实验证（本机 Docker runner）：容器重启后进程全没了，run/ 下的
// server.lock 与 status.json 留在磁盘上，PID 从小号重新分配。用例把残留文件里的 PID 指向
// 一个同用户的存活进程，复现“旧 PID 被复用”，再从 Desktop 连接。

const execFileAsync = promisify(execFile);

/** 远端账号：SSH 用例登录 dev，Docker transport 以容器默认用户 root 执行。 */
export interface RemoteAccount {
  user: string;
  home: string;
}

export interface RemoteDaemonFiles {
  lock: Record<string, unknown> | null;
  status: Record<string, unknown> | null;
}

async function shAs(container: string, account: RemoteAccount, script: string): Promise<string> {
  return (
    await execInRemoteContainer(container, ["env", `HOME=${account.home}`, "sh", "-c", script], {
      user: account.user,
    })
  ).stdout;
}

/** 用 Desktop 将要安装的同一份 archive 预装远端并启动 daemon，使连接直接进入 ensureDaemon。 */
export async function installAndStartRemoteDaemon(
  container: string,
  account: RemoteAccount,
  options: {
    desktopRoot: string;
    appVersion: string;
    /** 注入远端 Supervisor/Core 的 NODE_OPTIONS，用于测试接缝；update 拉起的 daemon 会先停掉。 */
    nodeOptions?: string;
  },
): Promise<void> {
  await installRemoteServerArchive(container, account, options);
  await shAs(
    container,
    account,
    [
      "set -eu",
      ...(options.nodeOptions
        ? [
            `"$HOME/.zcode/server/bin/zcode" stop --wait --server-root "$HOME/.zcode/server" --json >/dev/null`,
          ]
        : []),
      `${options.nodeOptions ? `NODE_OPTIONS='${options.nodeOptions}' ` : ""}ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "$HOME/.zcode/server/bin/zcode" serve --daemon --server-root "$HOME/.zcode/server" --json >/dev/null`,
    ].join("; "),
  );
}

/** 用 Desktop 将要安装的同一份 archive 安装到远端 `~/.zcode/server`，不启动 daemon。 */
export async function installRemoteServerArchive(
  container: string,
  account: RemoteAccount,
  options: { desktopRoot: string; appVersion: string },
): Promise<void> {
  const machine = (await shAs(container, account, "uname -m")).trim();
  const target = machine === "aarch64" ? "linux-arm64" : "linux-x64";
  const archive = resolve(
    options.desktopRoot,
    "mock-cdn/releases",
    options.appVersion,
    `zcode-server-${target}.tar.gz`,
  );
  const remoteArchive = `/tmp/e2e-zcode-server-${account.user}.tar.gz`;
  await execFileAsync("docker", ["cp", archive, `${container}:${remoteArchive}`], {
    maxBuffer: 16 * 1024 * 1024,
  });
  await execInRemoteContainer(container, ["chown", `${account.user}:`, remoteArchive], {
    user: "0",
  });
  await shAs(
    container,
    account,
    [
      "set -eu",
      'b="$HOME/.zcode/server/.e2e-bootstrap"',
      'rm -rf "$b"',
      'mkdir -p "$b"',
      `tar -xzf ${remoteArchive} -C "$b" --strip-components=1`,
      // WSL/Docker 的 daemon 不注册 OS service，与 Desktop 的 Docker transport 一致。
      `ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "$b/bin/zcode" update --from-archive ${remoteArchive} --server-root "$HOME/.zcode/server" --json >/dev/null`,
      `rm -rf "$b" ${remoteArchive}`,
    ].join("; "),
  );
}

export async function readRemoteDaemonFiles(
  container: string,
  account: RemoteAccount,
): Promise<RemoteDaemonFiles> {
  const read = async (name: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse(
        await shAs(container, account, `cat "$HOME/.zcode/server/run/${name}"`),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  return { lock: await read("server.lock"), status: await read("status.json") };
}

/** docker restart：远端进程全部结束，文件系统保留；等 sshd 重新起来。 */
export async function restartRemoteContainer(container: string): Promise<void> {
  await execFileAsync("docker", ["restart", "--time", "1", container]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sshd = await execInRemoteContainer(container, ["pgrep", "-x", "sshd"], { user: "0" })
      .then(() => true)
      .catch(() => false);
    if (sshd) return;
    await new Promise<void>((done) => setTimeout(done, 200));
  }
  throw new Error(`容器 ${container} 重启后 30 秒内没有 sshd`);
}

/** 起一个同用户的空闲进程，代表“旧 PID 被同用户的其他进程复用”。返回它的 PID。 */
export async function spawnPidReuseHolder(
  container: string,
  account: RemoteAccount,
): Promise<number> {
  // 每个账号用不同的时长，pgrep 才能唯一定位。
  const seconds = account.user === "dev" ? 3601 : 3602;
  await execFileAsync("docker", [
    "exec",
    "--detach",
    "--user",
    account.user,
    container,
    "sleep",
    String(seconds),
  ]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pid = Number(
      (await shAs(container, account, `pgrep -n -f '^sleep ${seconds}$' || true`)).trim(),
    );
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  throw new Error(`容器 ${container} 内没有找到 sleep ${seconds}`);
}

/**
 * 把残留锁里的 PID 改成 holderPid。statusPid 为 holderPid 时，status.json 快照仍是 ready 且
 * PID 存活，probe 会复用旧端口（#14–#16）；为已死的 PID 时，probe 判定未就绪，直接 serve --daemon（#13）。
 * lockIdentity 给出时同时改写锁的 processIdentity，使持锁者按进程身份判定为同一进程。
 */
export async function pointStaleDaemonFilesAt(
  container: string,
  account: RemoteAccount,
  pids: { lockPid: number; statusPid: number; lockIdentity?: string },
): Promise<void> {
  const replacePid = (file: string, pid: number) =>
    `sed -i -E '0,/"pid"[[:space:]]*:[[:space:]]*[0-9]+/s//"pid":${pid}/' "$HOME/.zcode/server/run/${file}"`;
  await shAs(
    container,
    account,
    [
      "set -eu",
      replacePid("server.lock", pids.lockPid),
      replacePid("status.json", pids.statusPid),
      ...(pids.lockIdentity
        ? [
            `sed -i -E 's/"processIdentity":"[^"]*"/"processIdentity":"${pids.lockIdentity}"/' "$HOME/.zcode/server/run/server.lock"`,
          ]
        : []),
    ].join("; "),
  );
}

/** kill -9 锁里的 Supervisor 与快照里的 Core，模拟非正常死亡；等两者都不存在后返回。 */
export async function killRemoteDaemon(container: string, account: RemoteAccount): Promise<void> {
  const files = await readRemoteDaemonFiles(container, account);
  const pids = [files.lock?.pid, files.status?.pid].filter(
    (pid): pid is number => typeof pid === "number" && pid > 0,
  );
  if (pids.length === 0) throw new Error(`容器 ${container} 内没有可结束的 daemon 进程`);
  await shAs(container, account, `kill -9 ${pids.join(" ")} 2>/dev/null || true`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const alive = await Promise.all(pids.map((pid) => isRemotePidAlive(container, account, pid)));
    if (alive.every((value) => !value)) return;
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  throw new Error(`容器 ${container} 内 daemon 进程 ${pids.join(",")} 10 秒内未退出`);
}

/**
 * 造一个已退出但未被回收的进程（僵尸）并返回其 PID。父进程 exec 成不回收子进程的 sleep，
 * 与 PID 1 不回收子进程的容器里 Supervisor/Core 死亡后的状态相同（ZCT-2117275161536565248）。
 */
export async function spawnZombieProcess(
  container: string,
  account: RemoteAccount,
): Promise<number> {
  const seconds = account.user === "dev" ? 3603 : 3604;
  await execFileAsync("docker", [
    "exec",
    "--detach",
    "--user",
    account.user,
    container,
    "sh",
    "-c",
    `sleep 0.5 & exec sleep ${seconds}`,
  ]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const zombie = Number(
      (
        await shAs(
          container,
          account,
          // 子进程还没退出时循环里最后一次判断为假；显式 exit 0，交给外层轮询重试。
          `p=$(pgrep -n -f '^sleep ${seconds}$' || true); [ -n "$p" ] || exit 0; for c in $(pgrep -P "$p" || true); do [ "$(awk '{print $3}' /proc/$c/stat 2>/dev/null)" = Z ] && echo "$c"; done; exit 0`,
        )
      ).trim(),
    );
    if (Number.isInteger(zombie) && zombie > 0) return zombie;
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  throw new Error(`容器 ${container} 内 10 秒内没有出现僵尸进程`);
}

/** 按 lock.ts 的 Linux 规则读取进程身份：boot_id 加 /proc/<pid>/stat 的 starttime。 */
export async function readRemoteProcessIdentity(
  container: string,
  account: RemoteAccount,
  pid: number,
): Promise<string> {
  // comm 可能含空格；与 lock.ts 一样从最后一个 ")" 之后数，starttime 是其后第 20 个字段。
  return (
    await shAs(
      container,
      account,
      `printf '%s:%s' "$(cat /proc/sys/kernel/random/boot_id)" "$(awk '{ s = $0; sub(/.*\\) /, "", s); split(s, f, " "); print f[20] }' /proc/${pid}/stat)"`,
    )
  ).trim();
}

/** 远端以 systemd 为 PID 1（`run-local-docker.mjs --systemd`）时，SSH 连接走 OS service 启动方式。 */
export async function isRemoteSystemdTarget(container: string): Promise<boolean> {
  return await execInRemoteContainer(container, ["test", "-d", "/run/systemd/system"], {
    user: "0",
  })
    .then(() => true)
    .catch(() => false);
}

/**
 * ready 之后连续 kill -9 Core，直到 Supervisor 耗尽崩溃预算进入 crash-loop-stopped（R3-ISSUE-031）。
 * 每次等新的 Core 起来再结束它，使每次结束都计入崩溃预算。返回最终的 status.json。
 */
export async function driveRemoteCrashLoop(
  container: string,
  account: RemoteAccount,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + 120_000;
  let lastKilled: number | undefined;
  while (Date.now() < deadline) {
    const { status } = await readRemoteDaemonFiles(container, account);
    if (status?.state === "crash-loop-stopped") return status;
    const pid = status?.pid;
    if (status?.state === "ready" && typeof pid === "number" && pid !== lastKilled) {
      await shAs(container, account, `kill -9 ${pid} 2>/dev/null || true`);
      lastKilled = pid;
    }
    await new Promise<void>((done) => setTimeout(done, 200));
  }
  throw new Error(`容器 ${container} 内 120 秒内未进入 crash-loop-stopped`);
}

export async function isRemotePidAlive(
  container: string,
  account: RemoteAccount,
  pid: number,
): Promise<boolean> {
  return (await shAs(container, account, `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`))
    .trim()
    .startsWith("alive");
}
