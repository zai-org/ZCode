# 01 — E2E home 位于仓库内，E2E 工作区被当成本仓库的一部分

Status: needs-triage

## 现象

默认 E2E home 是 `packages/desktop/.e2e-home-<runId>`（`packages/desktop/scripts/run-windows-e2e-shards.mjs` 的 `homeRoot`），位于仓库或 worktree 内。E2E 打开的工作区（默认 `ZCodeProject`、草稿目录 `.zcode/workspace/draft-*`）没有自己的 `.git`，向上找到的是本仓库。结果有三个：

1. Host 的 Git 自动刷新递归监听本 worktree 的 git 目录和主仓库的共享 `.git`（`packages/services/src/git/repo/gitCliRepo.ts` 的 `buildAutoRefreshWatchPaths`）。
2. 模型请求的 gitStatus 段带开发者当前的分支名和改动文件列表，环境段为 `Is a git repository: true`。
3. 模型请求带本仓库根目录 `AGENTS.md` 的全文（`Contents of <repo>/AGENTS.md (project instructions, checked into the codebase)`）；Agent 还读取仓库根的 `.zcode/config.json`（日志 `Project hooks pending workspace trust`）。

## 证据

- 抓包 `desktop-e2e-20261104150410828-p43101-0466bc15c24aa38c`：第一条 Native 请求含 `Current branch: <开发者分支>`、`Status:` 下的工作区改动列表，以及仓库根 `AGENTS.md` 全文。
- `desktop-e2e-20261104145522184-p3406-ab66e8833bcaced1`：Host 监听主仓库共享 `.git` 时一次 `open()` 卡住 73 s，Host 停止响应，MCPW08 超时。见 [Host 同步 fs.watch 存量问题](../host-file-watcher-legacy/01-sync-fs-watch-blocks-host-rpc.md)。
- Agent 用文件系统向上查找 `.git`（`apps/zcode-cli/packages/adapters/src/context/git-snapshot.ts` 的 `findGitRoot`），不经过 git 命令，所以 `GIT_CEILING_DIRECTORIES` 只能挡住 Host 的 git 命令，挡不住第 3 条。

## 影响

- E2E 的请求字节依赖开发者的分支、未提交改动和仓库 `AGENTS.md`：换分支、改文件或改 `AGENTS.md` 都会改变 E2E 请求，E2E 结果不可复现。
- 主仓库 `.git` 很大或文件系统卡顿时，E2E 会偶发卡住。

## 处理方向（未定）

- 默认 E2E home 放到仓库外（系统临时目录）。runner 先补回归测试；同步更新写死该路径的文档（`docs/desktop/e2e-process-lifecycle.md`、`docs/desktop/dev-build-watch.md`、`docs/testing/upstream-provider-e2e.md` 等）；跑全量 conversation E2E，核对请求变化（不再带 gitStatus 和仓库 `AGENTS.md`）。
- 只设 `GIT_CEILING_DIRECTORIES` 不够，原因见证据第 3 条。

## 来源

2026-11-04 在动态 MCP 分支排查 Native E2E 偶发失败（MCPW08 一步）时发现。E2E home 的位置早于该分支；该分支不修复。
