# 06 — 删除、旧版本清理与存储归属

Status: done

## Parent

[01 — 桌面文档工具预装：LibreOffice](01-libreoffice-preinstall.md)

## What to build

让用户能回收磁盘，并保证磁盘占用不随升级累积；同时让其他清理功能不会误删受管资源。

- 已就绪时，卡片提供“删除”。点击后弹出确认框，文案见 spec（自动预装开启时追加“下次启动会重新下载”）。
  - 删除前检查是否有从受管安装目录启动的进程。有则拒绝删除，卡片显示“正在被文档任务使用，请稍后再试”，状态保持已就绪。
  - 先撤销安装记录，再删除文件；没删完的残留在下次启动时清理。删除不改变开关。
- 新目标版本发布后，下次 App 启动时删除其他版本目录。目标版本未就绪时，旧受管版本不再给 Agent 使用，对话框也不显示它。
- “清除所有数据”不删除受管资源。资源管理器存储页把受管资源单独归类显示，不提供清理。
- 正式版与预览版各自使用独立的安装根目录，同时运行时互不覆盖。

## Acceptance criteria

- [x] LOP-25：确认框文案正确；无调用时删除成功，卡片变为未安装，开关不变；有调用时拒绝删除并显示原因。
- [x] LOP-26：新目标版本就绪后重启，旧版本目录被删除，新版本可用。
- [x] LOP-27：正式版与预览版同时运行并各自准备，安装到各自的目录，互不覆盖，各自状态正确。
- [x] LOP-28：执行“清除所有数据”后受管资源保留；存储页单独显示该类，不提供清理。

## Blocked by

- [04 — 预装工具对话框完整交互](04-dialog-full-interaction.md)

## 验证

全部在本机 macOS arm64 上完成。

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 桌面 E2E：覆盖 LOP-25、26、28。LOP-25 的“正在使用”用一个从受管目录启动的长时间运行的测试进程模拟。
  新用例按 [E2E 用例生命周期](../../../.agents/skills/e2e-case-lifecycle/SKILL.md)转正。
- LOP-27：在本机同时启动两个发布版本（例如开发版与预览版构建），检查两个安装根目录和各自的状态；
  如果无法自动化，就记录手动验证的步骤和结果。

## Comments

### 2026-10-28 — 完成

- 实现 commit：`e6c4e62e947`；基于 `23cd234c639` 开始，并已合入集成前置修复 `24ed016af5c`。
- 删除由预装进程执行。当前 release 的调用标记和实际程序／库映射经过门禁检查；普通文件读取不阻止删除。无法确认空闲时保留记录和文件，不终止正在使用的进程。
- 先更新 spec 01：按钮删除当前 release 下全部版本；活动记录原子改名为 `deleting-record.json` 撤销可用性。该文件只保存未完成删除，不供 Agent 使用；恢复只操作当前 release 的固定路径，不信任记录内容扩大删除范围。
- 运行证据发现并修正两处时序：旧版本仅在真正 App 启动时清理，worker 崩溃重启不提前清理；删除方先取 usage 名称快照，再取 PID 快照，避免误删后到活调用的标记。交错探针复现了旧顺序丢 marker、新顺序保留 marker。
- 资源管理器增加独立不可清理类别，服务层拒绝该类别清理。ClearAll 先调用现有退出屏障，再清除既有 v2 范围；受管资源保留，自定义数据根的既有引导规则未改。
- 验证通过：根 typecheck、lint（172 项既有 warning，0 error）、architecture（0 violation）；E2E typecheck、三个 fixture 检查、受影响工程测试 3/3、改动文件格式、diff 和竞品词检查。
- 本机 macOS arm64、App 3.16.3、小型可控资源：删除／存储和双发布身份最终批跑 2/2 PASS，run `desktop-e2e-20261027214457801-p17851-9a6187a80a958bab`。覆盖原生程序占用、活／陈旧 marker、查询无法判定、普通读取负例、其它 release 保留、旧版本清理与崩溃恢复。临时 packaged preview 使用既有 Electron 和 electron-builder 构建，原生 isPackaged 为 true，与 development 同时准备并产生独立记录；未安装到系统应用目录。
- ClearAll 候选在 run `desktop-e2e-20261027212224472-p99674-658c353fabd45a01` 中 PASS：真实清除隔离 v2、退出写入方、冷新会话复用同一安装身份，下载／运行检查各一次。该来源批跑的旧双身份候选曾因调试端口文件位置失败，不能把来源整个批跑称为通过；双身份已在上述最终批跑修正通过。
- 测试环境说明：ClearAll 的原生确认与自动 relaunch 由一次性测试边界控制；真实 exit 前释放测试 Main inspector，避免调试连接阻止退出，再创建冷会话。没有给产品增加等待或延时。直接复制未重命名的 Electron.app 不是真正 packaged 身份，已舍弃；最终采用真实目录包。
- 待人工审核：`conversation-session-preinstalled-tools-delete.test.ts`、`conversation-session-preinstalled-tools-clear-data.test.ts`、`conversation-session-preinstalled-tools-release-isolation.test.ts`，均位于 `conversation-session/manual-review/pending/`；没有转正或宣称正式覆盖。中／英文、深／浅主题的删除确认、忙提示和存储截图已检查。
- 证据已复制到本地协调目录 `evidence-ticket06`；保留对应 `.e2e-artifacts/<runId>/` 的日志、截图、facts、逐用例结果，以及进程与 marker 交错探针。清理工作树不会丢失这些证据。
- 未验证：真实 LibreOffice 调用和 CDN、Windows／Linux 的实际进程探针与 UI；本次运行验证仅 macOS arm64。切换数据根迁移资源不属于本票，未宣称覆盖；其它平台实际运行仍交 12。
