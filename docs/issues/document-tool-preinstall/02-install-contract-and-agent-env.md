# 02 — 安装契约与 Agent 环境注入

Status: done

## Parent

[01 — 桌面文档工具预装：LibreOffice](01-libreoffice-preinstall.md)

2026-10-28 修订：Host 仅有当前平台发布目标时注入安装记录路径；无目标时不注入。内部 unavailable 定位不可发布，变量只定位程序，不决定回退或安装权限。

## What to build

先定下预装工具进程、统一调用脚本和转换工具共用的契约，再让本机 Agent 在任何会话中都能找到安装记录的位置。
完成后，后续三条线（03 预装工具进程、07 统一调用脚本、09 转换工具）可以并行开工，不必各自猜格式。

- 资源清单、安装记录、安装目录布局、归档格式和运行检查方式有严格类型和运行时校验。
  - 清单字段见 spec“资源制作、发布和本机安装”：工具版本、系统与架构、下载地址候选、归档格式、字节大小、SHA-256、入口、必需文件、运行检查。
  - 安装记录只指向当前目标版本，写入安装记录是唯一发布点。
- 安装根目录按发布版本（正式版、预览版、开发版）区分，解析规则只有一处实现，Host、预装工具进程和测试共用。
- 新增的 Agent 环境变量先在 CLI 设计文档中定义用途、优先级、错误行为和测试覆盖，再实现。
- Host 仅在当前构建有本机平台目标时向本机 Agent 注入该变量，值为本发布版本当前构建目标安装记录文件的固定路径，与安装状态无关；安装记录尚不存在时照常注入。
- 远端工作区（SSH、WSL、Docker）、Web 服务端和独立 CLI 不注入该变量。

## Acceptance criteria

- [x] 清单与安装记录的契约覆盖 spec 列出的全部字段；字段缺失、类型错误或平台未知的输入被运行时校验拒绝。
- [x] 同一台机器上正式版、预览版、开发版解析出不同的安装根目录，且只有一处解析实现。
- [x] CLI 设计文档已定义该环境变量，内容与实现一致。
- [x] 有目标的本机会话中，Agent 的 Bash 命令能读到该变量；Bash 快照建立后发出的新命令仍能读到（为 LOP-16 做准备）。
- [x] 有目标但安装记录不存在时照常注入；没有目标和远端工作区不注入（远端运行验证限制见 Comments）。
- [x] 不改 App ↔ Agent 协议，不改系统提示词。

## Blocked by

None (can start immediately)

## 验证

全部在本机 macOS arm64 上完成。

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；CLI 侧运行 `pnpm --dir apps/zcode-cli typecheck`、`lint` 和受影响测试。
- CLI 测试：建立 Bash 快照后执行新命令，断言变量值为预期路径。
- 桌面 E2E（provider replay）：本机会话中让 Agent 执行读取变量的命令，断言输出路径。新用例按
  [E2E 用例生命周期](../../../.agents/skills/e2e-case-lifecycle/SKILL.md)走待审核、回放证据、人工审核后再转正。
- 远端不注入：用现有远端 E2E 环境验证；环境不可用时列为未验证项，不写成通过。

## Comments

### 2026-10-28 — 已授权的目标地址隔离修订

用户批准当前目标身份进入固定记录地址，解除聊天启动对工具目录健康的依赖。合同先更新至 01 与 CLI spec；保留单环境变量、单 owner、同会话继续及 release 级删除保护。

- 当前记录为 `records/<resourceId>/<version>-<platform>-<arch>/installation.json`；无目标为不可发布的 `unavailable/installation.json`。Main 同源静态配置同时交给 Host 和 worker，Host 不等待工具初始化。
- 统一脚本严格核对地址身份和版本目录，调用标记与删除门仍位于 release 根；四份脚本均先修改上游再同步，未改变非受管旧版回退、POSIX 子树清理及 Python 3.9 退出语义。
- 根 typecheck、lint、architecture；CLI typecheck（33/33）、lint、安装契约与四插件调用测试（4/4）；受影响工程（35/35）通过。上游 Python 3.12 runtime 25/25、migration 6/6；Python 3.9 为24通过、1因缺 openpyxl 跳过；打包及36插件校验通过。
- 本机 pending 桌面回放：startup/env/tracer/delete 为4/4，run `desktop-e2e-20261027235532815-p93185-269610ead2701322`；controls/faults/clear-data/release-isolation/empty 为5/5，run `desktop-e2e-20261027235927536-p98069-7adb086fc7595c67`。未转正；真实远端、Windows/Linux 运行未复验。
- 本轮增量与完整证据已外置交集成；依赖既有未提交插件功能，不将继承的112文件混入单独提交。最终集成 commit 由集成票记录。

### 2026-10-28 — 完成

- 实现 commit：`18d4df69d47`、`5f378dd2932`。已合入基线修复 `d2a08f9e74e`，
  该前置提交只移动既有 CLI model 类型，解除原有 max-lines lint 阻塞。
- 共享契约：`packages/shared/src/preinstalled-tools/contract.ts`、`node.ts`；CLI spec：
  `apps/zcode-cli/docs/design/v2/preinstalled-document-tools.md`。桌面 Local Host 注入固定记录路径，
  远端和 Web 装配不注入；Agent spawn 边界清除继承来的同名值。
- 先更新 spec 01 再实现：统一 tar.gz、发布身份目录和严格记录格式；为保留 macOS 官方 `.app` 签名，
  加入指向安装内私有资源视图的可选 `resourceBasePath`。为避免删除后重装的身份混淆，
  安装记录增加每次发布新生成的 `installationId` UUID，并定义 `usage` 与 `deletion-gate` 路径。
  同时明确 03 的启动屏障和 06／07 的调用、删除时序，不增加定时器或任务恢复机制。
- 验证通过：根 `pnpm typecheck`、`pnpm lint`（172 项既有 warning，0 error）、
  `pnpm architecture:check --changed`（0 violation）；桌面 `typecheck:e2e`、fixture check；
  CLI typecheck 33/33、CLI lint（71 项既有 warning，0 error）；CLI 安装契约／Bash 快照测试 16/16；
  `desktopProductIdentity.test.ts` 工程测试 10/10；改动文件格式、diff 和竞品词检查。
- 本机 macOS arm64、App 3.16.3、case-local provider replay：候选
  `conversation-session/manual-review/pending/conversation-session-preinstalled-tools-env.test.ts` 1/1 PASS，
  run `desktop-e2e-20261027170812440-p41550-303967f8a4a678bc`。
  移除 Host 注入的对照 run `desktop-e2e-20261027170042925-p34497-0a17d0562a7195d3`
  在空记录路径断言失败。证据为对应 `.e2e-artifacts/<runId>/` 的回传、日志和 `lop-env-continued.png`；
  已另外保存在本地协调目录，清理 worktree 不会丢失。候选仍待人工审核，没有转正或计入正式覆盖。
- 环境修复：新 worktree 的缓存 esbuild 缺少文件，用同版本 npm 包恢复；一次回放因并发
  `tsc -b` 覆写桌面构建输出而导致 Host 启动失败，改为串行检查后成功，未增加产品规避逻辑。
- 未验证：真实远端 SSH／WSL／Docker 不注入、Windows/Linux 运行。本票只验证定位合同，
  不代表安装事务、删除竞态、真实 LibreOffice 转换、字体或 CDN 验收；这些分别由后续 ticket 负责。

### 2026-10-28 — 最终提交记录

- 最终集成 commit：`8d5b8529d7d9b42db91fedb561f6a330ca54810d`。目标记录地址与 07/08 helper 消费合同成对提交；沿用本轮 9/9 桌面证据和真实包原 session 继续证据。最终根 typecheck、lint、architecture、CLI 检查和 87/87 交点工程检查通过。
