# managed-worktree-shared

受管 worktree 的共享规则，供 Host（services）与 CLI 共用，规格见 `docs/git/worktree.md` §5.3 与 `docs/specs/workspace-hook-trust.md` D23。

- `layout`：受管根目录 `<dataBaseDir>/.zcode/worktrees/<bucket>/<name>` 的纯路径计算，不做 IO。
- `resolveWorkspaceHookTrustIdentity`：Hook Trust identity 唯一实现。远程 identity 原样返回；本地受管 worktree 经 `.git` 文件、gitdir 反向链接、commondir、源仓库 `.git` 与 realpath 校验后映射到源仓库对应路径；任一步失败返回自身路径（不继承）。
- 文件读取只通过调用方注入的 `WorkspaceHookTrustIdentityFs` 端口完成；本模块不直接访问文件系统。
