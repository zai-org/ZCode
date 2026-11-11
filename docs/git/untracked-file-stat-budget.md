# 未跟踪文件行数统计的读取预算

更新日期：2026-09-14

## 原因与范围

Windows 3.12.1 日志中 Host 多次出现约 2.67 GiB 堆外内存峰值，伴随 Git 刷新。
现有 `buildUntrackedStats` 对所有未跟踪文件并发 `readFile`，完整加载后才识别二进制。
隔离复现中，256 MiB 二进制文件使堆外内存增加约 256 MiB，最终全部返回零行。
`git status` 的 512 KiB 输出限制只约束路径列表，不能约束文件内容大小。

本次修复 Git 状态刷新中的未跟踪文件统计；不调整 Git 命令、已跟踪文件统计或 diff 预览。

## 行为合同

- 单文件统计上限为 1 MiB，超过上限的文件保留变更条目，行数沿用不可统计文件的 `added=0, removed=0`。
- 普通文本在预算内保持精确行数：支持空文件、LF、CRLF、末尾无换行及跨块换行。
- 先检查文件类型和大小，只读取普通文件；每次最多读取 64 KiB，任意块发现 NUL 即按二进制返回零行。
- 每次统计最多四个 worker，各自复用一个 64 KiB Buffer；读取缓冲总量最多 256 KiB，不随文件数量或总大小增长。
- 文件在检查后继续增长时，最多读取 1 MiB + 1 字节用于判断越界；越界返回零行，不返回部分计数。
- 删除、读取失败、非普通文件保持零行回退；已打开句柄在成功、二进制、越界和异常路径均关闭。
- 不增加持久缓存、后台计时器、第二份 Git 状态或新的 RPC。

## 所有权与顺序

```text
桌面/手机 Web/远程 workspace 的现有 Git refresh
  → workspace 所在服务的 GitCliRepo.getStatus
  → 未跟踪条目 → 四个 worker → 大小检查 → 分块统计 → 同一 status 快照
                                          └─ 大文件/二进制/失败 → 零行，条目保留
```

读取预算与 worker 仅属于一次 repo 查询，现有 in-flight 合并和 UI 迟到结果判断保持原样。
文件路径仍用 workspacePath/repoRoot；不新增身份缓存，不改变 workspaceIdentity 隔离。
共享 services 实现覆盖 Windows/macOS/Linux、本地及远端执行；不涉及 Agent runtime、
CommandInbox、owner、snapshot、desktop continuous 或 mobile replayable 链路。

## 验证合同

- 单测验证真实小文件行数、超限文件不读内容、二进制提前停止、四 worker 上限、增长竞态和句柄回收。
- 既有 Git repo/service 回归验证条目和 staged/unstaged 行为保持兼容。
- SP13 pending 文件附加独立资源回归：真实 watcher 自动刷新后小文件更新为 `+4 -0`，超限文本不计行数，记录 Host working set 峰值；不依赖 Git pane 导航。
- 以相同 8 × 32 MiB 二进制文件复跑修复前的内存探针，对照堆外内存增量。

## 本次验证（2026-09-14）

- 相同 8 × 32 MiB 二进制文件，直接执行实际 helper：修复前堆外内存增量约 256 MiB，修复后约 0.3 MiB；两次统计结果均为零行。
- Git helper / repo / service：35 项单测通过；新增读取预算测试在旧实现上为 4 失败、1 通过，修复后全部通过。
- 真实 macOS Electron 资源回归通过，自动刷新后状态栏为 `+4 -0`，Host working set 峰值增量 1,648 KiB；独立重跑为 464 KiB（1 case 通过），没有调用模型。报告位于 `packages/desktop/.e2e-artifacts/desktop-e2e-20260914-041207-001/summary.md`。
- `pnpm typecheck`、desktop `typecheck:e2e`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 保留原有 42 项 warning，无 error。
- 原有 SP13 `Changes` 打开 Git pane 的 pending 场景本轮失败，未执行到大文件读取；附加资源回归独立运行，不宣称修复该导航问题或整个 pending 文件通过。
- conversation 覆盖率审计仍报 I74/I75 未知缩写、计数与生成文档过期；用当前 HEAD 的临时干净目录运行得到同样错误，本次不修改审计基线。
- Windows、Linux、手机远控与远端 workspace 未实机验证；共享 repo 实现未改协议/身份隔离，E2E 用 Git 元数据变化触发刷新以兼容 Linux 非递归监听。

资源回归独立运行命令：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec ./test/e2e/conversation-session/projects/conversation-session-git-review-entry.test.ts \
  --mochaOpts.grep 'Git 自动刷新'
```
