# managed-worktree-repo

受管 worktree 的 Git adapter，规格见 `docs/git/worktree.md` §3.4、§3.6、§6.3、§6.5。

- `list`：解析 `git worktree list --porcelain -z`，只返回位于 `<dataBaseDir>/.zcode/worktrees/<bucket>/<name>`、`.git` 为文件的条目；目录缺失时标为 `missing`。
- `create`：解析起点 commit，项目主目录是仓库子目录时校验起点中存在该子目录；非递归 mkdir 原子占用 bucket，执行 `git worktree add --detach`；`carryChanges` 时先在源 checkout 只读地读取已暂存 / 未暂存补丁与未跟踪文件，检出后应用（`carry-failed`）；再按 `.worktreeinclude` 从主 checkout 拷贝被忽略文件（`copy-failed`）。任一步失败只回滚本次 bucket 并 prune。
- `remove`：只接受受管 worktree 根；先做 dirty 预检返回结构化原因，再执行 `git worktree remove`（`force` 时加 `--force`），空 bucket 一并删除。任务占用检查由调用方完成。
- 所有 git 调用经同一个 `GitCommandProvider`，继承其环境隔离（清除 `GIT_DIR` 等）。错误使用 `ManagedWorktreeErrorCode`，不依赖 git 报错文本做流程判断。
