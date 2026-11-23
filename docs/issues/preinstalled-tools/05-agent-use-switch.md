# 05 — 每个工具的“Agent 使用预装版本”开关

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

用户可以在每张卡片上关闭“Agent 使用预装版本”。关闭后，Agent 的下一条命令就改用这台电脑上已有的程序；打开后恢复。开关不影响下载和删除。

- **设置**：
  - 新增 `preinstalledToolsAgentDisabled`，内容是被关闭的 `toolId` 列表；没有这个设置表示全部开启。
  - 写入前做运行时校验。只由预装进程写入，走现有的设置写队列。
- **命令与状态**：
  - 新增命令 `set-agent-enabled {toolId, enabled}`、`sync-entries {toolId}`；每个工具增加 `agentEnabled` 和独立的 `entryOutOfSync`，不复用准备错误 `error`。
  - 设置保存成功后，立即更新唯一开关值，再改入口并推送状态；入口 IO 失败也不回滚设置、不保留另一份旧开关。保存失败时保留原值，在卡片内提示重试，不弹 Toast。
- **入口**：
  - 对齐成功时，入口只在“安装记录有效且开关打开”时存在；入口 IO 失败的暂时差异由 `entryOutOfSync` 标记。
  - 关闭开关：删除该工具的全部入口。打开开关：有有效记录就写回入口。
  - 初始化重建入口时，同样按开关决定。
- **卡片**：
  - 增加开关，说明文字为“关闭后，Agent 使用这台电脑上已有的 {name}。”，提供中英文。
  - 删除工具不改变开关。
  - 入口未同步时保留提示“开关已保存，但尚未生效，请重试。”和独立“重试”按钮，不替换原操作按钮；中英文均不使用“入口”术语。
- **统一对齐与恢复**：发布、开关、初始化和重试使用同一按事实源对齐工具的函数，统一设置/清除标记。`sync-entries` 只重建入口，不下载、不改设置，不加定时重试。删除撤入口失败即中止并保留记录/目录，显示相同提示。日志记录工具、失败方向和 IO 原因；在修复点留中文注释说明旧缓存为什么会复活已关闭入口。
- 接入 03、04 时保持其已完成的成功路径与顺序；本次已明确授权上述失败语义。若还需改变其它既有行为，先在本票记录，再请用户确认。

## Acceptance criteria

- [x] 关闭某个工具后，同一会话的下一条命令执行 `command -v <入口名>`，结果是系统程序或找不到，与实际调用一致；其他工具不受影响；重新打开后恢复（PT-14）。
- [x] 在 Agent 启动的 MCP stdio 服务和 hook 中，入口随开关出现和消失（PT-23）。
- [x] 关闭 LibreOffice 后，统一入口使用系统版本，并输出“未就绪或已关闭”（LO-06）。
- [x] 重启后开关保持原状态；设置保存失败时，开关保持原值并提示重试。
- [x] 关闭开关不取消下载，也不删除资源；删除工具不改变开关。
- [x] bin 只读时关闭开关：设置已保存，快照为已保存值，卡片出现未生效提示；恢复权限并点独立重试后入口与开关一致、提示清除。测试结束恢复权限。
- [x] 关闭时入口 IO 失败后，再发布或升级也不能把入口写回来；重建只能使用已保存偏好。
- [x] `sync-entries` 不发任何下载请求、不改设置；删除撤入口失败时记录与目录保留。
- [x] controls 候选或一个新候选覆盖以上交互，回放通过，仍保持待审核。

## Blocked by

- [03 — 多工具契约、串行准备与按工具删除](03-multi-tool-contract-and-queue.md)

## 验证

- 根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，以及受影响的工程测试；设置 schema 变化按现有设置校验规则检查。
- CLI：MCP stdio 环境中入口可见的测试。
- 桌面 E2E 候选在本机 macOS arm64 回放，不转正。

## Comments

- 接入 03/04：初始化改为逐工具撤入口、清理旧版本、按保存事实重建，避免共享 `bin/` 的整体删除把单工具 IO 失败变为全部工具准备失败。撤入口失败保留该工具版本；无主入口清理失败不回收移出 catalog 的目录。成功后的结果与占用检查规则不变。此项按已确认的入口失败合同实施。

- 实现提交：`880fd41c4253a9d94dcdc038d6a54012e825dccc`（`feat(preinstall): add per-tool agent switches`）。已保存 disabled 列表是唯一开关事实；快照和全部入口对齐直接读取它。入口失败保留资源/设置，独立提示与重试已落地。
- 根检查通过：`pnpm typecheck`、`pnpm lint`（172 个现有 warning、0 error）、`pnpm architecture:check --changed`（0 violation）。工程 `pnpm test:engineering scripts/preinstalled-tools/catalog.test.ts packages/desktop/test/preinstalledToolsFaultServer.test.ts packages/desktop/test/tsupChunkIsolation.test.ts` 35/35；新增命令/状态契约先失败再通过。修改文件格式检查、fixture 检查和 E2E 类型检查通过。
- CLI 检查通过：`pnpm --dir apps/zcode-cli typecheck`（33 tasks）、`pnpm --dir apps/zcode-cli lint`（0 error、71 warning，9 项原样上游行数诊断）；adapters 的 `preinstalled-tools`、`libreoffice-entry`、`document-python-entry`、`mcp-network` 共 19/19，bootstrap 的 `preinstalled-tool-environment` 1/1。后者使用真实长存 MCP stdio 服务和 Hook runner，覆盖入口增删恢复及显式 PATH 覆盖。
- macOS arm64 桌面候选通过且保持 pending：agent-switch run `desktop-e2e-20261029155305152-p10314-bab690ee4c564f64`（1/1）；upgrade/startup 在合批 `desktop-e2e-20261029155427965-p14336-a7c62b11fcf0d620` 通过（2 项）；delete 定向 `desktop-e2e-20261029155824788-p30195-a467f57c681204b6`（1/1）。中英、深浅主题、760×640 与键盘交互通过，四张未生效提示截图已逐张查看。
- 失败证据保留：旧代码真实只读 bin 诊断 `desktop-e2e-20261029091906812-p69079-6b1ba6d3c387317a` 证明保存 false 后旧 owner 值会使入口复活。新候选首轮 `desktop-e2e-20261029155004204-p96287-746b42e38f9cb5ff` 因视觉切换写入语言/窗口设置而干扰整设置比较；分离视觉步骤后仍用整文件严格比较重试前后不变。合批的 delete 失败来自已废弃 usage 标记假设，按 03 规格修正候选，不改产品。后两次定向回放复用同次 App/CLI 构建，修正前后产品逻辑未变。
- 未验证：Windows/Linux 原生入口与权限/占用差异、其他架构执行，以及真实五工具资源全链路；这些由 12/13 的对应范围处理。本票没有发布 catalog、push、MR 或远端 Issue，也未转正任何 E2E。

- 2026-10-30 review 修正（`2f93d5836ff`）：工程 catalog 测试移除 App 命令、状态投影、设置持久化与宿主资源选择断言，仅保留制作/发布实际使用的资源 schema 门禁（7 项通过）。本票上方历史测试数与运行记录保持原样；这些已删除断言不再计为当前工程覆盖。开关、保存失败及入口重试仍以现有 `conversation-session-preinstalled-tools-agent-switch` pending 候选为证据；空 catalog 与平台缺资源仍由现有 pending 候选验证。本次未重跑桌面 E2E，未转正候选。
