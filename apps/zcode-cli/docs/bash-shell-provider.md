# Bash Shell Provider 当前实现

更新日期：2026-11-10

本文最初是 Bash 执行形态的实现计划。实现已经完成并继续扩展到 Windows、runtime shell selection、
startup source 和 embedded search prelude；下面记录当前事实，不再是待执行 plan。

## 当前契约

Bash tool 创建：

```ts
command: {
  mode: "shell",
  command: input.command,
  shellProfile: "posix-bash",
}
```

`shellProfile` 是 execution port 的内部 profile：只有 Bash tool 设置，generic shell、hook 和配置 runner
不得继承。adapter 对这个 profile 解析真实 shell 并尽量用 `shell: false` 直接 spawn；无法解析时显式返回
`legacy-shell` selection，并降级到旧系统 shell。

## Shell 选择

```text
user-config selection（新 session 与 cold resume 都读取当前设置）
  -> platform auto-detect
  -> legacy system shell fallback
```

POSIX：

- `$SHELL` 是 bash/zsh 且可执行时优先；
- 否则按用户 shell 偏好在 PATH 和 `/bin`、`/usr/bin`、`/usr/local/bin`、`/opt/homebrew/bin`
  查找 bash/zsh；
- provider 设置 `SHELL=<resolved path>`、`GIT_EDITOR=true`，并直接执行该 binary。

Windows：

- 用户显式选择可用 Git Bash 或 CMD；
- 未显式选择时查找默认 Program Files Git Bash，再从 `git.exe` 位置反推；
- Git Bash 使用 `dialect=git-bash`、`shell=false`；CMD 使用 `dialect=cmd` 和 cmd shell；
- 没有可用选择时回到 legacy system shell。

provider 只注入上面列出的通用变量和 ZCode 自己命名的变量，不引入其他产品命名的环境变量。

## Runtime selection

shell 是 runtime 初始化时读取的设置，而不是每个 Bash call 重新读取的全局设置：

- 首次真实用户执行前初始化 `bashShellSelection`；deferred draft 可在首发前刷新 Environment context；
- cold resume 同样读取当前设置，不恢复 session 创建时的 shell；selection 不落库；
- runtime 存活期间不热更新；shell 设置变化对新 session 立即生效，对已有 session 在下次 cold resume 时生效；
- shell 变化由 environment 公告告诉模型：` - Shell: <new> (was <old>)`，随请求写库，冷恢复原位还原，
  不重复追加。

workspace path/identity 不参与 shell identity；实际 executable 可用性由 Agent 运行环境判断。远程 session
因此使用远程机器的 shell，而不是 desktop 本机 `$SHELL`。

## Startup source 与 embedded search

`bash-startup-script.ts` 只对 `posix-bash` profile 生效：

- 在 ZCode storage 的 session `bash-startup/` 目录物化 0600 source script；
- Git Bash 路径转换为其可读格式；
- 可选 leading sources 与 embedded search prelude 按顺序 `. <quoted path>`；
- CMD/legacy dialect 不注入 POSIX source；
- script 文件名包含内容 hash，相同内容复用。

这条链路用于把 bundled bfs/ugrep 等 search prelude 放进实际 Bash 环境，不改变 model-visible command，
也不把 generic execution 变成 Bash。

## cwd persistence

foreground Bash 的 `captureCwdAfterSuccess` 继续由 execution adapter 的 cwd capture plan 实现：

```text
prepare command
  -> apply startup sources
  -> wrap cwd capture
  -> resolve shell provider
  -> spawn
  -> exit 0 时读取 resolvedCwd
  -> runtime.setWorkingDirectory
```

background Bash 在 start 时清掉 cwd capture，不更新 session cwd。shell provider 不能建立第二套 cwd file 或
把 cwd persistence 搬到 core handler。

## 当前代码与测试

- `packages/contracts/src/interfaces/execution.port.ts`
- `packages/core/src/tool/handlers/bash.ts`
- `packages/core/src/runtime/methods/session-shell-environment.ts`
- `packages/adapters/src/exec/bash-shell-provider.ts`
- `packages/adapters/src/exec/bash-startup-script.ts`
- `packages/adapters/src/exec/cwd-capture.ts`
- `packages/adapters/tests/exec.test.ts`
- `packages/adapters/tests/bash-startup-script.test.ts`
- `packages/core/tests/bash-handler.test.ts`

测试覆盖 POSIX bash/zsh 语法、Windows Git Bash/CMD、固定目录和 PATH fallback、legacy fallback、env
overlay、cwd capture、background behavior、startup source、cold resume 读取当前 shell 并公告变化，以及 generic
shell 不读取 Bash profile。

## 边界

- shell provider 不承诺用户 rc/profile 的全部交互式行为；启动参数和 source 策略以 adapter 测试为准。
- Bash tool 的 provider-visible 行为契约以 `apps/zcode-cli/docs/design/v2/tool/04-bash.md` 为准；本文件只描述
  selection/execution architecture。
