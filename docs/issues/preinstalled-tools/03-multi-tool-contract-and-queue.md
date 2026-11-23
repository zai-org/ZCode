# 03 — 多工具契约、串行准备与按工具删除

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

预装进程按 catalog 管理多个工具。每个工具可以单独下载、取消和删除；多个工具按 catalog 顺序一次只准备一个；对话框每个工具一张卡片。完成后，在 catalog 中增加一个工具不需要改链路代码。

- **契约**：按规格的 [Catalog 与资源清单](../../preinstalled-tools/README.md#catalog-与资源清单) 和 [进程与状态](../../preinstalled-tools/README.md#进程与状态) 实现。
  - catalog 是工具列表。资源清单包含 `platforms`、`binaryArch`、`archive`（下载地址只接受 `downloadUrlsByRegion`）、`installedSizeBytes`、`requiredFiles`、`entries`、`runtimeChecks`。实现全部 catalog 校验规则。
  - 安装记录位于 `tools/<toolId>/installation.json`，包含 `requiredFiles` 和 `entries`。
  - 状态为 `{autoInstallEnabled, tools[]}`。命令 `prepare`、`cancel`、`delete` 带 `toolId`。
  - 不在本票范围：`rewrite` 字段（[06](06-install-rewrite-and-resign.md)）、`installed` 状态与升级（[04](04-upgrade-and-startup-cleanup.md)）、“Agent 使用预装版本”开关（[05](05-agent-use-switch.md)）。
- **装配**：
  - Main 读取内置 catalog，按平台为每个工具选资源，按地域规则排序下载地址。内置 catalog 保留本期五个工具描述，顺序按规格；各工具的 `resources` 均为空，不放未发布的资源。
  - E2E 覆盖变量改名为 `ZCODE_E2E_PREINSTALLED_TOOLS_CATALOG`，只在 E2E 编译开关打开时读取。
- **预装进程**：
  - 每个工具一个 owner，复用现有安装事务。全局一个串行队列，排队中的工具阶段为 `queued`。
  - 取消只影响该工具：正在执行就中止，在队列中就移出。删除等该工具的在途操作结束后再执行。
  - 运行检查经过入口执行，支持 `${INSTALL_DIR}`、`${INSTALL_DIR_URL}`、`${CHECK_TEMP_DIR}`、`${CHECK_TEMP_URL}`。入口按安装记录中的入口定义生成，取代 02 中写在代码里的 LibreOffice 参数。
  - 删除以下机制：调用标记目录、删除门、删除意图记录、`installationId`、旧版根级记录，以及运行时的归档身份文件核对。身份核对移到打包，见 [07](07-packaging-common-and-libreoffice.md)。
  - 每次初始化清空每个工具的 staging。“只保留记录指向的目录”的启动清理由 04 实现。
- **对话框**：
  - 按 `tools[]` 渲染卡片。工具名、用途、排队文案“等待其他工具准备完成…”、删除确认标题“删除 {name}？”和占用提示都按工具显示。
  - 五个工具的用途文案按各工具规格的“作用”一节编写。建议如下，评审时可以调整：
    - Python：用于运行文档插件的脚本，并提供表格、Word、PDF 处理库
    - qpdf：用于 PDF 拆分、合并、加密和修复
    - Pandoc：用于读取 Word 文档的内容
    - Poppler：用于 PDF 转图片和提取文字
    - LibreOffice：用于文档转 PDF、PPT 转换和表格公式重算（沿用）
- **测试 catalog**：E2E 使用两个真实 `toolId` 的小型夹具资源，验证串行准备和按工具隔离。

## Acceptance criteria

- [x] 工程测试证明 catalog 校验拒绝以下情况：重复 `toolId`、同平台多个资源、入口重名、入口目标不在必需文件中、显式下载列表。
- [x] 干净目录启动后，两个测试工具按 catalog 顺序依次准备，同一时间只有一个在下载（PT-01）。
- [x] 取消一个工具后只有它停止，队列继续下一个，重试会重新下载（PT-05）；重复点击只触发一次准备（PT-07）；旧消息不覆盖新操作（PT-08）。E2E 只证明取消会中止旧请求、紧邻重试独立推进；owner 层旧消息晚到没有单独构造。
- [x] 各类故障显示对应文案，不留半成品入口（PT-09）；代理与备选 CDN 的行为不变（PT-10）。
- [x] 每个工具一张卡片，关闭对话框不中断准备（PT-11）；中英文、深浅主题、小窗口和键盘操作可用（PT-12）。
- [x] catalog 为空或当前平台没有资源时，卡片显示“当前版本暂未提供此工具。”，没有下载请求（PT-24）。初始化故障显示可重试状态，进程不反复重启（PT-25）。预装进程崩溃后重新拉起，不自动下载（PT-22）。远端工作区提示不变（PT-19）。
- [x] 删除一个工具只影响它自己的入口、记录和目录。
- [x] tracer、controls、faults、empty-catalog、startup、remote-context 六个候选按新合同改写，回放通过，仍保持待审核。

## Blocked by

- [02 — Agent 通过固定入口目录使用 LibreOffice](02-agent-bin-entry-libreoffice.md)

## 验证

- 根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，以及受影响的工程测试。
- 跨进程消息、preload 和设置都按 schema 校验，三侧都要核对。
- 桌面 E2E 候选在本机 macOS arm64 回放，不转正。

## Comments

- 实现 commit：`ee766fb7e39a4f331fdf605910ee127b0edbbef0`（`feat(preinstalled-tools): prepare catalog tools serially`）。开工 HEAD 为 `e4dcf2080da`，完成前已合入集成分支 `6eff4fbbf02`（含 08）。worktree 基线核对与 freshness 通过。
- catalog、状态和命令已通用化；每工具使用固定发布点与独立 owner，准备共用串行队列。公开入口与运行检查共用记录里的入口定义，运行检查在最终版本目录执行；已删除运行时归档身份核对、调用标记、删除门与删除意图记录。旧 LibreOffice 打包器暂时使用其目录内的 producer-only schema，以保持顺序实施期间可构建；07 迁移时删除该过渡，不恢复旧 App 协议。
- 必要检查通过：根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；`pnpm --filter @zcode/desktop typecheck:e2e`；CLI `pnpm --dir apps/zcode-cli typecheck`、`pnpm --dir apps/zcode-cli lint`。根 lint 172 warnings / 0 errors；CLI lint 71 warnings / 0 errors，9 项原样上游行数接纳；architecture 0 violations。
- 工程：`pnpm test:engineering scripts/preinstalled-tools/catalog.test.ts packages/desktop/test/preinstalledToolsFaultServer.test.ts scripts/libreoffice packages/desktop/test/tsupChunkIsolation.test.ts`，63 项通过。catalog 与多工具/真实资源夹具变更均先有失败回归、后通过。CLI adapters 的 `preinstalled-tools.test.ts`、`libreoffice-entry.test.ts`、`document-python-entry.test.ts` 共 16 项通过；旧 CLI 清单/路径断言迁移前实际出现 2 失败、1 通过，按新契约更新后全部通过，未改 CLI 产品逻辑。
- 六个 pending 候选的 fixture check 与 macOS arm64 回放通过，App 3.16.3：tracer 首次 run `desktop-e2e-20261029065729459-p16013-b88b99c92df13ba3`；补齐活动取消、自动预装关闭后队列继续和公开 qpdf 入口执行的 run `desktop-e2e-20261029071436648-p50458-8cb108a089f579a3`；controls/faults/empty-catalog/startup 合批 run `desktop-e2e-20261029070743770-p39766-096451673079f4e8`，4/4；真实 SSH remote-context run `local-docker-20261029071659-f4752d`，1/1，Linux arm64 Agent 的 AVAILABLE 与预装 PATH 均不存在，临时容器已删除。全部候选保留 pending，未转正。
- 已查看多卡排队、五卡无资源、中英文、深浅主题和小窗口截图；controls 保留键盘、迟到响应、发布失败、动态进度条与 reduced-motion 断言。faults 保留断连、校验/解压/运行失败、磁盘空间、代理/CA、候选顺序、旧记录/入口保留和 staging 清理。不适用平台由 Main 装配为 `target:null`，对应 PT-24 的“暂未提供”与零下载；不把旧归档身份错误当成平台兼容证据。
- 未通过的初次执行也保留：首次离线依赖安装遇 pnpm 临时目录 rename ENOENT，原目录重跑成功；首轮类型检查发现旧状态断言与命名冲突，已修；架构初轮发现 contract 超出 300 行，按 schema 声明/跨字段校验分离后通过；批跑 `desktop-e2e-20261029070140983-p23309-becbf58f6e110638` 因 brace 通配符被逗号分割而匹配到 0 个用例，改成明确路径清单后执行通过。CLI typecheck 初次因嵌套 workspace PATH 缺根目录已安装的 turbo 未执行，临时把根 `node_modules/.bin` 加入该命令 PATH 后 33 个任务通过，无依赖或锁文件修改。
- 未验证与后续范围：原生 Windows/Linux 桌面与 Windows `.cmd`、Git Bash 行为（13）；五个真实资源与文档效果（12）；升级/启动回收（04）、每工具开关（05）、路径改写（06）。delete、clear-data、release-isolation、real-loopback 候选已同步新协议中受类型/路径影响的部分，本票未回放其完整后续场景，交由 04/12 验证。小型夹具不代表真实资源兼容性。
- diff、文档链接和竞品词检查通过。开源提醒仍报告既有 coverage matrix 的 private-signing 与 package.json 的内部流程项；没有新增此类内容。源码与完整成功/失败运行工件、验证日志保留在本次任务独立 artifacts 的 03 目录。
