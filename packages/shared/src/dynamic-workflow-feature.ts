// ============================================================
// Dynamic Workflow 灰度：服务端 feature key 的取值域与客户端快照
// ============================================================
// 服务端 `/api/v1/client/configs` 下发 `data.configs.dynamicWorkflow.mode`。

// 这里只放三端（Host services、Desktop main、UI）共用的取值域、归一化与快照形状；
// 读取远端、覆盖与下发都在各自的 owner 里，不在 shared 层发请求。

export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/**
 * 本地覆盖用的环境变量。语义按构建档位分三层，由 Desktop main 在 fork Host 前**改写或删除**
 * （desktopRuntimeEnv.ts 的 buildHostProcessEnv），Host 只消费不再分辨来源：
 *   - 未打包 dev：透传开发者 shell 里的合法取值；
 *   - 打包 preview：固定写入 `alwaysOn`，忽略 shell；
 *   - 打包 production：删除继承值，永不写入。
 * 没有 main 的 Web/server Host 直接读进程环境（运维/开发者设置）。
 */
export const ZCODE_DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/**
 * 服务端**成功响应**但未下发该 key、或取值非法时的取值：disabled。
 * 服务端撤掉 key 等于关闭灰度，不能沿用旧快照。请求失败不走这里，见下一个常量。
 */
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

/**
 * 灰度配置**请求失败**（断网、接口报错、远程设备连不上服务端、读取抛错）时的「提供」：onDemand。
 * 为什么与 key 缺失区分：请求失败说明不了服务端的意图，过去一律按 disabled 处理，
 * 离线启动的 Host 会到重启前都没有工作流入口；功能已全面可用，读不到也要保留入口。
 * 为什么是 onDemand 而不是 alwaysOn：alwaysOn 让每个新会话首轮就注册十个工作流工具，
 * 太占上下文；onDemand 入口（+ 菜单、/ 面板、自动化页、Resume）都在，模型工具面推迟到
 * `/workflow`、Resume 或恢复带工作流的会话才注册（launch.md「On demand: activation」）。
 * 只有一次成功响应才能把默认值关掉。用户选择与本地覆盖仍在它之上生效。
 */
export const DYNAMIC_WORKFLOW_MODE_ON_FETCH_FAILURE: DynamicWorkflowMode = "onDemand";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

/**
 * 「功能是否提供」的折叠：`onDemand` 与 `alwaysOn` 同为开启——目录里的 `/workflow`、技能、
 * 自动化页的工作流 tab 与 Resume 入口在两种模式下都在。两者的差别只在模型工具面的注册时机
 * （launch.md「On demand: activation」），由 CLI 侧按 mode 本身裁决，这里不参与。
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** 快照的来源：观测用，UI 与日志据此区分「服务端关」与「本地覆盖」。只描述「提供」来自哪里。 */
export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";

/**
 * 灰度快照（launch.md「Gray release」「The user's choice」）。两层：
 *   - 提供（offer）：服务端 key 或本地覆盖决定默认是哪个模式，记在 `offeredMode`（disabled 也只是默认值）；
 *   - 生效（effective）：用户在设置里的明确选择永远取代提供的模式，记在 `mode` / `enabled`。
 * 旧消费者读 `mode` / `enabled` 即得生效值；设置页读 `offeredMode` 决定「默认」标签。
 */
export interface DynamicWorkflowClientConfig {
  /** 生效模式：用户有选择时是用户选择，否则等于 offeredMode。 */
  readonly mode: DynamicWorkflowMode;
  /** 等于 isDynamicWorkflowModeEnabled(mode)；单独落字段免得每个消费者各写一遍折叠规则。 */
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
  /** 服务端（或本地覆盖）提供的模式：用户没选时的生效模式，也是设置页的「默认」选项。 */
  readonly offeredMode: DynamicWorkflowMode;
  /** 实际生效的用户选择；缺席表示跟随提供的模式（未选择或非法值）。 */
  readonly userMode?: DynamicWorkflowMode;
}

export function createDynamicWorkflowClientConfig(
  offeredMode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return {
    mode: offeredMode,
    enabled: isDynamicWorkflowModeEnabled(offeredMode),
    source,
    offeredMode,
  };
}

/**
 * 读快照里服务端提供的默认模式（与用户选择无关）；设置行与中枢的「工作流设置」只在读得到时出现。
 * disabled 也是合法的默认值：此时行照样出现，「默认」标签落在「关闭」上。
 *
 * 快照可能来自没有 offeredMode 的旧 Host（新 UI——例如手机远控 bundle——连旧桌面）。旧 Host 不认
 * 用户选择，摆出设置行只会把选择写进一个不生效的设置，所以缺席或读不懂的 offeredMode 返回 undefined：
 * 只有认用户选择的 Host 才会写这个字段。
 */
export function readDynamicWorkflowOfferedMode(
  config: DynamicWorkflowClientConfig,
): DynamicWorkflowMode | undefined {
  return normalizeDynamicWorkflowMode(config.offeredMode);
}

/**
 * 「服务端给默认、用户选择永远生效」规则的唯一实现（launch.md「The user's choice」）：
 *   - 合法的用户选择取代提供的模式，提供的是 disabled 也一样——功能已全量，服务端只决定默认值；
 *   - 缺席或非法值（旧文件、未来版本写入的新值）按跟随提供的模式处理。
 * 只从 `offeredMode` 推导，所以对已应用过选择的快照再次应用是覆盖而不是叠加：Host 闩住的是提供，
 * 每次使用都用最新选择重新应用。
 */
export function applyDynamicWorkflowUserMode(
  config: DynamicWorkflowClientConfig,
  userMode: unknown,
): DynamicWorkflowClientConfig {
  const offer = createDynamicWorkflowClientConfig(config.offeredMode, config.source);
  const choice = normalizeDynamicWorkflowMode(userMode);
  if (!choice) return offer;
  return {
    ...offer,
    mode: choice,
    enabled: isDynamicWorkflowModeEnabled(choice),
    userMode: choice,
  };
}

/**
 * 纯函数：把远端 envelope 的 `configs.dynamicWorkflow` 与本地覆盖环境变量折叠成「提供」，再应用用户选择。
 * 提供的优先级：覆盖 > 远端合法值 > 缺省。远端成功但**未下发**该 key 也视为 disabled——
 * 服务端撤掉 key 等于关闭，不能沿用旧快照（与 desktopContextPromptRollout 同一裁决）。
 */
export function resolveDynamicWorkflowClientConfig(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
  userMode?: unknown;
}): DynamicWorkflowClientConfig {
  return applyDynamicWorkflowUserMode(resolveDynamicWorkflowOffer(input), input.userMode);
}

function resolveDynamicWorkflowOffer(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
}): DynamicWorkflowClientConfig {
  const override = normalizeDynamicWorkflowMode(input.env?.[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]);
  if (override) return createDynamicWorkflowClientConfig(override, "override");
  const remoteMode = normalizeDynamicWorkflowMode(
    typeof input.remote === "object" && input.remote !== null
      ? (input.remote as { mode?: unknown }).mode
      : undefined,
  );
  if (remoteMode) return createDynamicWorkflowClientConfig(remoteMode, "remote");
  return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
}
