# Onboarding 记录本地持久化 Spec

> 分支：`prototype/onboarding-suggestions`
> 状态：已实现（本地存储阶段；服务端上传接口待定，预留 `uploadState`）

## 1. 背景与目标

新用户引导（OccupationOnboarding，三步向导：职业 / 模式 / 偏好）目前只在完成后把偏好写入
`~/.zcode/v2/setting.json`（`onboardingOccupation` 等字段），没有独立的"引导完成记录"。
产品需要：

1. 把三页收集的信息持久化到**独立的本地 JSON 文件**，后续开放上传给服务器；
2. 记录以**设备 id（deviceMid）**为锚点，支持**多个用户 id**（同一台电脑多人登录），
   也支持**没有用户 id**（使用 apikey、未登录）；
3. 引导只自动展示给本机尚未激活的身份：既没有作答/资格决策，也没有创建过真实
   Task/Session 时展示；已有本地 Task 的存量用户静默记为 `existing_local_user`，关闭引导的用户
   记为 `dismissed`，两者之后都不重复展示。

## 2. 数据结构

Schema 定义在 `packages/shared/src/onboardingRecord.ts`（类型 + zod，独立平级文件，
不并入 `validationAppSettings.ts`）：

```ts
interface OnboardingRecordEntry {
  userId: string | null; // OAuth user_id；apikey/未登录为 null
  occupation: string; // developer | ... | other（非空字符串，向前兼容）
  interfaceMode: "coding" | "office";
  memoryEnabled: boolean;
  proactiveSuggestionsEnabled: boolean;
  completedAt: string; // ISO 时间
  uploadState: "pending"; // 预留：上传成功后改 "uploaded"
}

interface OnboardingRecordFile {
  version: 2;
  deviceMid: string; // 首次写入时固化，之后不变
  entries: OnboardingRecordEntry[]; // 每 userId（含 null）至多一条，重复完成引导覆盖旧条目（覆盖后重置为 pending 等待上传；读取侧兼容旧版重复文件取最后一条）
  decisions: Array<{
    userId: string | null;
    status: "dismissed" | "existing_local_user";
    reason: "user_closed" | "existing_local_task";
    decidedAt: string;
  }>;
}
```

`entries` 仍是问卷答案及后续上传队列；`decisions` 只表达本机展示资格，不进入答案上传。
v1 文件不做启动迁移：读取时视为 `decisions: []`，下一次业务写入时自然落为 v2。

**跳过语义**：跳过是显式答案。某页被跳过时该字段记 `null`（职业页跳过 → `occupation: null`；模式页跳过 → `interfaceMode: null`；偏好页跳过 → 两个布尔记 `null`），与"明确选择了值"区分。settings 侧跳过仍落保守默认值（职业 `other` / 偏好关），区分度只体现在本记录文件。

存储位置：`getAppConfigDir()/onboarding-record.json`（即 `getDataBaseDir()/.zcode/v2/`，默认 `~/.zcode/v2/`；用户自定义数据目录时跟随 dataBaseDir，与 telemetry-state.json 等设备级数据一致。注意与 setting.json 不同——setting.json 固定留在 home，因为启动引导需要从固定位置读取 dataBaseDir）。原子写。

## 3. 关联语义

```
+----------------+          +---------------------------+
| deviceMid      |<---------| onboarding-record.json     |
| (本地稳定不变)  |          |  version: 2                |
+----------------+          |  entries: [                |
                            |    { userId: "u1", ... },  |  用户 A 登录完成引导
                            |    { userId: "u2", ... },  |  用户 B 之后登录完成引导
                            |    { userId: null, ... },  |  未登录/apikey 完成引导
                            |  ]                         |
                            +---------------------------+
                                           |
                                           | 后续上传（接口待定）
                                           v
                                  服务器（payload 自带 deviceMid + userId）
```

- `deviceMid` 由 renderer 经 `platform.getDeviceId()`（desktop 为 userData 路径 SHA-256，
  稳定）传入 service；落盘后以**文件内的值**为权威，重复写入不改变。
- `userId` 由 service 内部经 `oauthCredentialRepo.loadActiveUserProfile()?.id ?? null`
  补全，UI 不直接触碰 OAuth 层。

## 3.5 登录认领（claimAnonymousRecord）

同一人"未登录答一次 → 登录"不得被当成新用户重复引导：登录用户判定前先认领——
该 userId 无条目而存在匿名（null）条目时，把 null 条目**移交给**该 userId（改写，
不复制，避免同一引导行为双条目污染上传统计）。

```
[] → 未登录答 → [null]
  → 登录 A：移交 → [A]（不再触发引导）
    → 登出答（匿名）→ [A, null]
      → 登录 B：B 无条目 → 移交 null → [A, B]
        → 切回 A：A 有条目 → 不动
```

- 认领同时覆盖作答 entry 和资格 decision，只在登录用户自己两者都没有时发生；
  [A, null] 状态下登录 A 是幂等空操作。
- 匿名态失去记录后再次触发引导属预期（该态确实没有自己的记录）。
- UI 侧必须 await 认领完成后再 shouldOnboard，否则读到认领前文件会误判需要引导。

## 4. 触发规则（shouldOnboard）

```
启动 / 登录态变化（zustand user 改变）
        |
        v
 resolve userId = loadActiveUserProfile()?.id ?? null
        |
        v
 entries 或 decisions 存在 userId 匹配 ? -- 是 --> 不触发
        | 否
        v
 本机存在使用证据（任一命中即存量用户）？ -- 是 --> 写 existing_local_user，不触发
        | 否
        v
 触发引导（完成写 entry；关闭写 dismissed）
```

- 登录用户按 `userId` 精确匹配；未登录 / apikey 按 `userId === null` 匹配。
- **使用证据（2026-10 修订）按"任一命中"判断，三个来源按序检查**：
  1. 设备全局 tasks-index 存在任意 Task（`includeDeleted: true`，含已删除 tombstone——
     清空过任务列表的存量用户不因删除行为失去资格）；
  2. agent 会话库（默认 `~/.zcode/cli/db/db.sqlite`，按 homedir 展开、不随
     dataBaseDir 迁移；env/配置覆盖与不可镜像跳过规则见下条；SQLite 只读查询
     `session` 表存在至少一行）；
  3. 旧版任务快照目录（`{dataBaseDir}/.zcode/v2/sessions/`，含 `.deleted.json`）非空。
- **为什么不能只查 tasks-index**：索引是 session 同步器的衍生投影，同步器在 agent/provider
  就绪后才开始回填；而判定恰好在登录完成、主界面挂载时执行，早于回填。索引为空 ≠ 没有历史
  （2026-10 线上案例：dev 数据目录索引重建后，登录瞬间判定看到空索引，老用户被误弹引导；
  事后取证确认全部历史任务行都在 WAL 中、判定之后才落库）。
- **会话证据必须查会话库的行，不能用文件存在性或 cli/sessions 目录代替**（评审 CR-01）：
  文件存在不代表有会话（空库/刚建库）；`cli/sessions` 是工作流文件输出目录
  （`script-workflow-tool-port.ts`），拿它当证据会把用过工作流的新用户误判成存量。
- **会话库路径只镜像 host 可确定性复制的定位来源，无法确定按"未知"跳过**（评审
  三轮 CR-01：不在 host 复制完整 CLI 解析规则——相对路径按 agent 工作区 cwd、
  project 级配置按 workspace 叠加，host 均无法镜像）。可镜像来源按序：
  1. env `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB`（双别名并存按 env 键序取
     后者，与 CLI env adapter 覆盖顺序一致）；
  2. `~/.zcode/cli/config.json` 的 `storage.sessionDbPath`（CLI `createConfig`
     默认 user config 位置在 home，**不随 App dataBaseDir 迁移**）；
  3. 默认 `~/.zcode/cli/db/db.sqlite`（`~/` 按 homedir 展开）。
     值为绝对路径（含 `~/` 展开）才作为证据位置；相对路径 → 未知 → 跳过本证据源
     （继续检查旧版快照目录），不得按 host cwd 猜测。配置读取/解析失败（非 ENOENT）
     上抛：配置读不出来时会话库位置未知，猜测默认值会漏判自定义会话库的存量用户。
- 会话库以只读连接查询，WAL 未 checkpoint 的行对只读连接同样可见，与回填时序
  无关；库文件不存在（stat ENOENT）视为无证据，**其他异常（EACCES/ENOTDIR 等）
  上抛**由 UI 保守判不弹（评审 CR-02：existsSync 会把权限错误吞成 false，违反
  "结果未知不弹"约定）。
- 当前版本没有可靠的 Task 创建者身份归属，因此任一来源命中即把当前无记录
  身份视为存量用户。
- 手动快捷键打开引导（`newUserOnboardingOpen`）不受该规则限制，保存后同样追加记录。

## 5. 服务接口（IOnboardingRecordService）

| 方法                             | 说明                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `appendRecord(deviceMid, entry)` | 文件不存在则创建并固化 deviceMid；存在则追加；损坏时 warn 并重建；userId 由服务补全 |
| `shouldOnboard(deviceMid)`       | 触发判定；已有 Task 时写入 existing_local_user（见 §4）                             |
| `dismissOnboarding(deviceMid)`   | 关闭首次引导时写入 dismissed；已有作答时为空操作                                    |
| `getRecords()`                   | 读取整份文件（后续上传使用）                                                        |
| `clearRecords()`                 | 删除文件（调试用）                                                                  |

RPC 暴露链路与 settingService 相同：`ServiceChannels.OnboardingRecord` →
descriptor → `createLocalServices` 注册 → `RemoteServiceAccess` getter → UI hook。

### 5.1 手机远程工作区的服务连接

远程工作区的 service collection 必须暴露 `onboarding-record`，与该入口的 settings/OAuth
保持同源。R3 下 SSH/WSL/Docker 与 Server 统一走 Source Server 全转发
（[R3 主规格 §8.1](./architecture/r3-source-server-remote-architecture.md#81-权威表)），
settings/OAuth 都由 Source 持有，因此四种 transport 都转接 Source 自己的记录服务；
不得借用窗口 Local Host 的记录，也不得按项目另建记录服务或复制记录。

```text
手机新建远程任务 -> 新 workspace attachment -> 手机 allowlist -> onboarding-record RPC
  SSH/WSL/Docker/Server -> Source 原有服务 -> Source 身份（Provisioning 下发的 OAuth）、记录和任务索引
```

`onboarding-record` 属于 `RemoteWorkspaceRpcContract v1` 必有 channel，并在
`web-remote-replayable` attachment allowlist 内；漏放行时手机调用会超时，效果与漏注册相同。

故障原因是远程 service collection 漏注册此通道，手机重挂载 Root 后调用失败，回退到
settings 判定而误弹引导。修复只补服务装配；引导触发规则、settings 失败兜底、Root 重挂载
以及 desktop-continuous/web-remote-replayable 的任务传输语义均沿用既有实现。

回归覆盖：已有记录但 settings 无职业字段时，手机进入远程草稿不展示引导；首次用户仍展示，
关闭后重建连接仍保持已关闭；远程集合使用 Source 的记录服务，不能误读桌面记录。服务装配测试
通过真实 RPC 验证读写路由和错误传播；浏览器回归使用真实引导组件、服务装配和手机 allowlist，
任务入口与传输环境使用隔离夹具，不代替真机配对及 SSH/WSL/Docker 传输端到端验收。

- RPC 回归：`packages/desktop/test/hostRemoteWorkspaceServices.test.ts`、
  `packages/desktop/test/windowHostAttachmentRpcPolicy.test.ts`。
- 浏览器候选用例（待人工审阅）：
  `packages/desktop/test/e2e/remote-control/connection/manual-review/pending/mobile-remote-onboarding.mjs`，
  从仓库根目录执行 `pnpm exec tsx <用例路径>`。

## 6. UI 集成（OccupationOnboarding.tsx）

- 引导操作文案必须在中英文语言包中完整定义，不能回退显示原始翻译 key：
  `start` 为“开始使用” / “Get started”，`continue` 为“下一步” / “Next”，
  `saving` 为“正在保存…” / “Saving…”，`back` 为“返回” / “Back”，
  `error` 为“保存失败，请重试。” / “Failed to save. Please try again.”。
  回归测试覆盖上述五个 key 的两种语言，确保后续埋点也能复用有效按钮文案。

- 顶部导航使用等宽左右列与居中进度列：返回在左、步骤进度在正中、关闭在右，按钮垂直居中且左右外边距一致；首步隐藏返回仍保留其列，不移动进度。

- 职业选项图标使用 20px（size-5），选中圆圈保持 16px。
- 跳过与下一步按钮字号统一使用 text-ui-base（默认 14px）。

- 布局：桌面双栏由外层统一提供 4px 四周留白与栏间距；右侧插画面板复用主界面圆角规则
  （Windows 5px、macOS 26+ 12px、旧版或未知 macOS 6px、其他平台 12px）。
  左侧职业、模式、偏好选择卡片统一使用首层容器圆角 rounded-xl；本页面按设计要求将下一步、上一步、跳过、关闭等按钮统一为 rounded-xl，与选择卡片一致，不修改全局按钮默认圆角。
  右侧 Hero 覆盖 1px 主题边框，沿用面板圆角，不占布局空间、不接收指针。
  Hero 使用左对齐的品牌介绍布局：Logo、标题、副文案共享左边线，内容组垂直居中，最大宽度 640px。
  面板左右留白随窗口宽度在 64–72px 之间变化，上下留白保持 32–72px，Logo 与标题间距 40px，标题与副文案间距 24px。
  窄屏沿用单栏表单与原有滚动边界，不显示 Hero；短窗口允许面板滚动。
  Hero 展示文案按本页面设计使用独立字号：标题随内容区宽度在 24–48px 之间变化、半粗、1.15 倍行高，保持单行；副文案 16px、26px 行高，英文两句话在句号后显式换行，窄窗口中长句仍可自然折行，不随 UI 字号缩放；标题沿用 Hero 主题文字色，深色副文案使用浅蓝灰提高对比度。
  Hero 文案对齐官网品牌标题：英文“Simple, Fast, Vibe‑Ready!”，中文“简单、迅捷、氛围十足！”；副文案围绕多智能体完成复杂目标与随处掌控，采用适合引导面板的简短版本。
  内容组顶部直接复用初始化页面的品牌图标组件（含尺寸、黑色渐变底、描边及圆角），深浅主题不反转；引导页关闭动画，初始化页面保留原有动画。
  引导 Logo 的黑底与白色 Z 保持静止，仅在 1px 圆角边框内增加淡白色扫光，光尾覆盖约 120°，5 秒绕行一圈，带柔和光尾、不产生外围光晕；减少动态效果时隐藏扫光。
  背景仅引用欢迎区 Hero 的蓝色主题色值（深色为深蓝黑与青蓝，浅色为冰蓝白与天蓝），
  叠加独立实现的流动 WebGL 光场（参考 Mesh Flow 6 的视觉方向，非官方预设代码），保持原有流场、透明度与速度，只替换底色和光带 RGB；不叠加 Hero 静态光晕或混合模式。
  移除轨道线。主波形约 3 秒一轮；背景不接收指针，仅可见桌面面板运行，最多 24fps，
  渲染长边不超过 960px。减少动态效果时固定画面，隐藏页面暂停，卸载释放 GPU 与监听资源；
  WebGL 不可用或上下文丢失时显示主题静态底色，不能阻塞引导。
  验收覆盖桌面大屏、短窗口及手机宽度的深浅主题，内容不得溢出或遮挡导航。

- 显示 gating：`requested || (needsOnboarding === true && !dismissed)`；
  `needsOnboarding` 为异步判定结果。**判定不得无限期拦截主界面**：存量用户
  （settings 已有 `onboardingOccupation`）不等判定直接进主界面；疑似首跑用户最多等
  3 秒。`appendRecord` 同样带 5 秒超时，channel 缺失时不会让保存按钮永久转圈。
- 兜底判定语义（2026-10 修订）：
  - **3 秒超时 → 保守判"不需要引导"**。原实现超时退回 settings 判定，但兜底闭包在
    effect 首跑时求值，而首跑时 settings 必未加载（`useSettings` 初始为 null），兜底值
    恒为"需要引导"——冷启动判定 RPC 超 3 秒（启动拥塞、tasks-index SQLite 首开慢、
    ws/relay 链路慢）的老用户被误弹，真实结果到达后引导闪现消失并已计入曝光埋点。
    超时只代表"结果未知"，不得据此打扰用户；真实结果到达后照常覆盖（真新用户的
    引导只是晚几秒出现，主界面先行）。
  - **3 秒放行预算与判定轮次分离**：settings 加载完成或身份变化触发的
    判定重跑只刷新判定上下文，不重新授予主界面阻塞时间。截止时刻在首个未决判定轮
    建立并跨轮共享，重跑只使用剩余预算，预算耗尽立即保守放行——主界面总等待不超过
    首轮建立的 3 秒上限。产生判定结果（真实结果 / 保守放行 / 失败兜底 / 用户完成
    引导）后预算结束；已有判定结果时，后续轮次的超时兜底不再生效，不得把已放行的
    主界面或正在进行的引导翻掉。
- **判定失败（rejection）、服务不可用 → 一律保守判"不需要引导"（2026-10 第二次修订）**。
  原实现退回 settings 判定（`!onboardingOccupation`），但该兜底会把"没填过引导的存量
  老用户"判成需要引导——与"老用户一定不弹"冲突，且 settings 快照在 effect 首跑时必未
  加载，历史上有过按陈旧快照误弹的缺陷。失败只代表"结果未知"，不得据此打扰用户；
  真新用户在故障场景最坏晚一次启动再弹（与超时语义同代价）。
- **settings 不再参与兜底判定**：`settingsLoaded` / `onboardingOccupation` 从触发 hook
  移除，hook 依赖收窄为 record 服务、userId、deviceMid。settings 侧的
  `onboardingOccupation` 仍只用于"存量用户不等判定直接进主界面"的 UI 放行（§6 显示
  gating）与推荐区内容，不再是引导资格的事实源。
- **3 秒放行预算与判定轮次分离**：身份变化（userId / record 服务实例）触发的判定重跑
  只刷新判定上下文，不重新授予主界面阻塞时间。截止时刻在首个未决判定轮建立并跨轮
  共享，重跑只使用剩余预算，预算耗尽立即保守放行——主界面总等待不超过首轮建立的
  3 秒上限。产生判定结果（真实结果 / 保守放行 / 用户完成引导）后预算结束；已有判定
  结果时，后续轮次的超时兜底不再生效，不得把已放行的主界面或正在进行的引导翻掉。
- 已知限制：无记录服务的宿主（home-only web 视图、纯渲染测试 double）自动引导恒不弹
  （保守语义的直接结果）；该端属于服务装配缺口（与 §5.1 手机远程工作区漏注册同类），
  修复方向是接入与桌面同源的记录服务，不在触发规则层兜底；缺口修复前用户仍可从设置
  页手动打开引导。
- `save()`：现有 settings update 成功后调 `appendRecord()`；追加失败仅 warn 日志，
  不阻塞引导主流程、不向用户报错。
- `onboardingOccupation` 等 settings 字段照旧写入（推荐 prompt 池仍依赖它），
  语义变为"当前用户最近一次选择的职业"。

## 6.5 引导再次打开时的预填与直接退出

- **预填**：从设置入口（或快捷键）手动打开引导、以及再次触发的引导，用该 userId 在
  record 里的最近作答初始化三页选项（`getLatestEntry()`）。跳过页记 null 的字段预填
  默认值（职业 developer / 偏好默认）；record 的职业不在当前列表（列表演进）时同样落
  默认。编程模式下主动工作记忆始终预填为关闭，即使此前在设置中手动开启并保存；办公
  模式下按最近作答预填，未作答时默认开启。预填数据异步后到时，若用户已交互则不覆盖其选择。
- **重新完成引导**：本次引导的选择作为新的配置写入 settings 和 record，覆盖此前在设置页
  或上次引导中保存的偏好。用户在编程模式下重开引导并直接保存，也会把此前手动开启的
  主动工作记忆改为关闭；这是预期行为。
- **直接退出**：引导页右上角 X 按钮与 ESC 均可退出——不保存、不改 settings，写入
  `dismissed` 资格决策，之后启动不再自动触发。设置里主动打开仍可随时关闭回到原界面；
  已有作答的身份关闭手动打开的引导时不新增决策。

## 7. settings 回填（换账号恢复偏好）

settings 不分用户，A 答完后 B 触发引导会把 settings 顶成 B 的答案。因此登录态变化
（或启动）判定"不需要引导"时，调 `syncSettingsFromRecord()` 把当前 userId 在 record 里
**最近一条**作答回填到 settings 的 `onboardingOccupation / proactiveSuggestionsEnabled /
memoryEnabled`，推荐区内容随之切换。约定：

- 回填时机（CR-03 修订）：**仅 userId 运行时变化后**（换号/登录）执行；挂载首跑（含启动时
  OAuth 异步恢复引起的 null→id）只做触发判定不回写——否则用户手动关闭的推荐/记忆开关
  会在每次启动被 record 复活。
- 手动修改回写 record（CR-03 修订）：推荐区关闭按钮、设置页建议/记忆开关在更新 settings
  的同时调 `updateRecordPreferences()` 回写当前用户条目（失败仅 warn 不阻塞），record 始终
  等于"该用户最新偏好"，回填因此不会覆盖任何手动修改。
- 跳过页记 null 的字段回填保守默认（职业 `other`、偏好关），与引导跳过写 settings 一致。
- record 的职业是非枚举字符串（职业列表会演进），回填前经 `appSettingsOccupationEnum`
  窄化，未知值落 `other`。
- 当前用户无记录时不改 settings；同步失败仅 warn 日志。

## 7. 上传预留（待服务端接口确定后实现）

引导曝光及结束的公共行为埋点另见 [用户引导埋点 Spec](monitoring/onboarding-telemetry.md)。
该事件上传结束时的选择快照（包括第三页跳过时的勾选状态），不等同于本地记录上传，
也不改变本记录的跳过字段置 null 规则或 uploadState。埋点模式使用 work/code，
本地 interfaceMode 继续使用 office/coding；身份字段复用公共 telemetry 的 user_id/device_mid。

- payload = 文件内 `uploadState === "pending"` 的 entries + deviceMid；`decisions` 不上传；
- 上传成功后将对应 entry 置为 `uploaded`；
- 触发时机待定（启动补报 / 登录后上报）。
