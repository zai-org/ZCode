# 02 — Agent 通过固定入口目录使用 LibreOffice

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

本机 Agent 通过固定入口目录 `bin/` 找到预装的 LibreOffice，插件统一入口不再读取安装记录。这是新入口机制的第一条完整链路：Host 注入、预装进程写入口、插件查找入口、删除时撤入口，端到端都能验证。

本票沿用现有的单工具预装契约（一个目标、一份安装记录）。入口参数暂时由预装进程按现有清单字段生成；[03](03-multi-tool-contract-and-queue.md) 再改为读取 catalog 中的入口定义。

- **Host**：
  - 启动本机 Agent 时，把 `<发布根>/bin` 放在 Agent PATH 最前面，并注入 `ZCODE_PREINSTALLED_TOOLS_AVAILABLE=1`。
  - 删除 `ZCODE_PREINSTALLED_TOOLS_RECORD` 的计算和注入。Host 不再接收预装目标，也不再等 Main 读完预装配置才启动。
  - Agent 进程管理在 spawn 边界只采用 Host 给出的值；Host 不注入时，清除继承来的同名值。远端、Web 服务端和独立 CLI 不注入。
- **预装进程**：
  - 安装记录有效时写入口 `zcode-soffice`。初始化时按安装记录重建入口目录。
  - 入口格式按规格：POSIX 为 sh 脚本；Windows 另写一行的 `.cmd`，值中的 `%` 写成 `%%`。都用“临时文件 + rename”写入。
  - macOS 入口传 `-env:BRAND_BASE_DIR=<资源视图的 file URL>`，并在调用方未设置时默认 `SAL_USE_VCLPLUGIN=osx`。
  - 删除时先撤入口，再检查进程占用；有占用就恢复入口，卡片提示占用。
- **插件统一入口**（四个文档插件同步）：
  - 先在 PATH 上找 `zcode-soffice`，再找系统 LibreOffice。
  - 删除读取安装记录、核对记录地址、调用标记、删除门检查和 installationId 复读的代码。预装版本的后端和资源视图由入口提供。
  - 入口在调用途中消失时，按“启动失败”处理，用系统版本重跑一次。
  - 工具都不可用时，按 `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` 是否存在选择引导文案。
  - 四个插件升版，版本权威保持一致。

## Acceptance criteria

- [x] 本机会话中，Bash 快照建立后 `<bin>` 仍排在 PATH 最前，`ZCODE_PREINSTALLED_TOOLS_AVAILABLE` 可以读到。远端 Agent 进程中两者都没有。
- [x] LibreOffice 就绪后，同一会话的下一次统一入口调用使用 `zcode-soffice`；删除后改用系统版本，或给出引导。
- [x] 统一入口的回归测试覆盖：入口存在与不存在、系统回退、预装失败后重跑一次、取消不重跑、入口中途消失、两种引导文案。
- [x] 新增工程门禁：四个插件中的统一入口和 profile 模板逐字节一致。
- [x] 删除空闲的 LibreOffice 时，入口先消失，再删除记录和目录；有调用时入口恢复，并显示占用提示。
- [x] 仓库中不再有 `ZCODE_PREINSTALLED_TOOLS_RECORD`；统一入口中不再有调用标记与删除门逻辑。
- [x] env、delete 两个桌面 E2E 候选按新合同改写，在本机回放通过，仍保持待审核。

## Blocked by

None (can start immediately)

## 验证

- 根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，以及受影响的工程测试。
- CLI：`pnpm --dir apps/zcode-cli typecheck`、`lint`，以及受影响包的测试，包括 Bash 快照与入口的测试。
- 桌面 E2E 候选在本机 macOS arm64 回放，按 [E2E 用例生命周期](../../../.agents/skills/e2e-case-lifecycle/SKILL.md) 处理，不转正。
- Windows `.cmd` 入口只检查生成内容，真机行为由 [13](13-other-platform-verification.md) 验证。

## Comments

- 实现 commit：`301083b7b2e69ed4eb6497927e4c83dcfcd2fc3d`（`feat(preinstalled-tools): use stable agent entries`）。基于集成分支 `feat/preinstalled-tools-generic`，开工 HEAD 为 `c1631d0ef58`，完成前已合入集成规格修订 `291f31bed6f`。

- 2026-10-29：按已确认规格完成固定入口迁移。测试先维护 env/delete 候选与 CLI ExecutionPort；CLI 新断言先得到 system 而失败，再改 PATH 查找后通过。工程一致性门禁先失败、实现后通过。安装记录与旧清理协议暂按本票边界保留，03 再通用化。
- 必要检查已通过：根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；`pnpm --filter @zcode/desktop typecheck:e2e`；CLI `pnpm --dir apps/zcode-cli typecheck`、`lint`。根 lint 有 172 条既有警告；CLI lint 有 71 条警告、9 条既有上游行数接纳，均为 0 errors。
- 工程：`pnpm test:engineering scripts/check-document-libreoffice.test.ts scripts/libreoffice/publication.test.ts`，7 项通过。CLI adapters 的 `preinstalled-tools.test.ts`、`libreoffice-entry.test.ts`，9 项通过；bootstrap `plugins.test.ts`，48 项通过；`node --test apps/zcode-cli/packages/cli/tests/sea-official-plugin-assets.test.mjs apps/zcode-cli/packages/cli/tests/build-sea.test.mjs`，45 项通过。首次 bootstrap 检查有 5 项失败（版本断言未同步及与构建期间读取资产交错）；同步断言、构建结束后重跑全部通过，首次记录保留。
- 桌面（macOS arm64，App 3.16.3）：env、delete、remote-context 三个 pending 候选均首次回放通过；各自 fixture check 通过。env run：`desktop-e2e-20261029061730912-p50146-a341d6f07e5c7bfa`；delete run：`desktop-e2e-20261029061945247-p55976-7c545c05834803f9`；remote run：`local-docker-20261029062241-b3fe3c`。远端使用 `node harness/remote/run-local-docker.mjs packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-preinstalled-tools-remote-context.test.ts`，真实 Linux arm64 Agent 的 AVAILABLE 和预装 PATH 均不存在；临时容器已自动删除。
- POSIX 入口的中文/空格路径、参数、默认及显式 macOS backend、入口删除已通过可重复本地执行检查；Windows `.cmd` 的单行结构与 `%` 转义内容检查通过。四插件的 launcher/profile 字节一致门禁接入根 lint。
- 未验证：Windows 原生 `.cmd`、Git Bash 与删除运行中入口（13）；真实 LibreOffice 资源和文档转换全链路（12）；本票同步了 startup/real-loopback 的旧环境变量夹具，但未回放，分别交由 03/12。旧变量只保留在历史文档及规格的删除说明中，产品代码与运行夹具已无引用。
- 原始工件与验证日志已保存到本次任务的独立 artifacts 目录（02），不依赖待清理 worktree。
