# 06 — 安装时改写路径与重签

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

资源可以声明“安装时要改写的文件”。预装进程解压后，把文件中的构建机占位符换成真实的安装目录；在 macOS 上对改写过的程序重新签名，然后再做运行检查。这样从 conda-forge 取得的程序，装到任意用户目录都能运行。

本票只做通用能力。Python、qpdf 和 Poppler 资源在后续票中使用它。规则见规格的 [安装事务](../../preinstalled-tools/README.md#安装事务) 第 6 步。

- **清单字段**：增加可选的 `rewrite`，每项为 `{path, placeholder, mode}`，`mode` 取 `text` 或 `binary`。`path` 必须是资源内的路径。
- **改写时机**：在必需文件检查之后、移入版本目录之前改写。
- **改写规则**：
  - 占位符换成最终版本目录的绝对路径。
  - `binary` 模式：保留 NUL 终止字符串的完整后缀，替换该段内所有占位符后在整段末尾补 0 字节，保持原长度；无 NUL 的末段以文件末尾为边界。长度按 UTF-8 字节计算。版本目录路径比占位符长时，报告 `unsupported`，日志写明两个长度。
  - `text` 模式：直接替换。
- **重签**：在 macOS 上，改写过的 Mach-O 用 ad-hoc 签名重签；没有改写的文件保留原签名。
- **失败处理**：改写或重签失败时，按对应错误处理，并清理本次安装。

## Acceptance criteria

- [x] 测试资源包含声明了改写的文本文件和 Mach-O 程序。安装到路径含空格和中文的用户目录后：
  - 经入口运行，能读到改写后的路径。
  - 在 macOS 上 `codesign --verify` 通过。
- [x] 路径超长时，卡片显示“暂不支持当前系统。”，不发布记录，也不写入口。
- [x] 改写中途取消或失败时，不留下半成品，已安装的旧版本不受影响。
- [x] 没有声明 `rewrite` 的资源，行为不变。
- [x] 新增或改写的 E2E 候选回放通过，仍保持待审核。

## Blocked by

- [03 — 多工具契约、串行准备与按工具删除](03-multi-tool-contract-and-queue.md)

## 验证

- 根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，以及受影响的工程测试。
- 桌面 E2E 候选在本机 macOS arm64 回放，不转正。Linux 和 Windows 上的改写由 [13](13-other-platform-verification.md) 验证。

## Comments

- 实现 commit：`fbaf9aacabf19327400c5bed8a9ded10c3480243`（`feat(preinstalled-tools): rewrite resource paths`）。开工 HEAD 为 `b7df7810732`，核对为集成分支当前提交，freshness 与架构基线通过；完成前已合入规格修订 `2443444cf09`，合并提交 `4569b2025b4`。
- 先明确 binary 模式的 NUL 字符串边界和 UTF-8 字节长度，再维护 pending 候选并实现。改写只作用于本次 staging；缺文件、超长、重签失败和取消都不改已发布记录或旧入口。实际改写的 Mach-O 使用 ad-hoc 重签，未变化文件不重签。
- 必要检查通过：根 `pnpm typecheck`、`pnpm lint`（172 条既有 warnings、0 errors）、`pnpm architecture:check --changed`（0 violations）；`pnpm --filter @zcode/desktop typecheck:e2e` 与 rewrite 候选 fixture check。没有修改 CLI 产品或测试代码，CLI 独立检查不适用。
- 工程：`pnpm test:engineering scripts/preinstalled-tools/catalog.test.ts packages/desktop/test/preinstalledToolsFaultServer.test.ts packages/desktop/test/tsupChunkIsolation.test.ts`，31 项通过。rewrite schema 先出现 unknown-key 失败后通过；夹具同报告目录隔离先出现 EEXIST 后通过；真实 HTTP 放行屏障先缺少 pending 行为而失败，再实现后通过。
- 桌面：macOS arm64、App 3.16.3，`conversation-session-preinstalled-tools-rewrite.test.ts` 回放通过，run `desktop-e2e-20261029081204150-p49787-fd19b828f361c709`，1/1。隔离 HOME 含中文和空格；固定入口实际运行重定位后的原生程序；text、同一 NUL 段重复前缀、完整路径后缀、无 NUL 末段及二进制总长均有断言。改写后的程序与未改写程序的 `codesign --verify --strict` 通过，未改写程序 SHA-256 不变。
- 复跑前置：在仓库根目录设置 `ZCODE_E2E_MANUAL_REVIEW=1`、`ZCODE_E2E_HOME_DIR="$PWD/packages/desktop/.e2e-home-中文 空格"`；`E2E_PROVIDER_REPLAY_FIXTURE_PATH` 使用 `packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-preinstalled-tools-rewrite.json`，再通过标准桌面 E2E 入口运行 pending 下的 rewrite 候选。夹具用本机 clang 与 codesign 生成测试程序，不下载真实工具。
- 失败/取消证据：超长路径提示“暂不支持当前系统”，日志记录 installationBytes=195、placeholderBytes=6；缺少改写文件、真实 codesign 拒绝 FinderInfo 均显示解压失败。HTTP 屏障放行后，观察到首个文本已改写才注入 FinderInfo 或取消；失败及取消后 staging 为空、未发布目标版本，旧记录一致且旧 qpdf 入口仍能执行。成功、超长和取消截图已查看，错误提示可读。
- 首次候选 `desktop-e2e-20261029080144079-p34099-b6efa7ec6023ab8f` 失败，完整记录保留：伪损坏 Mach-O 被 codesign 按 generic 文件成功签名，未触发预期故障。改用真实 Mach-O 的 FinderInfo 属性注入，实测 codesign exit=1 后重跑成功；不记为首次通过。初次类型检查因新 worktree 尚未生成 CUA dist 失败，运行 `pnpm build:cua` 后通过；初次离线依赖安装遇已知 hoisted esbuild rename ENOENT，无锁文件变更，已有工具可执行。
- 未验证：Linux/Windows 原生改写与签名相关平台行为（13）；Python、qpdf、Poppler 的真实资源效果（09～12）。本票只用小型原生夹具验证通用安装链路，候选保持 pending，未转正。原始成功/失败批次、运行日志和检查日志已保存在本次任务独立 artifacts 的 06 目录，桌面/资源独占权已释放。
