# CMD 只读判定

`Bash` 工具在 session shell 为 `cmd` 或 `legacy-shell` 时，不能用 Bash AST 判定只读（`type # & python x.py`
在 Bash 里只剩 `type`）。本模块按 CMD 语法做保守判定，只供 `bash.ts` 的 `resolveBashPermissionCapability` 调用。

- 只在实际执行器是 cmd.exe 时适用：Windows 上 `cmd` 且 path 匹配 Node 的 cmd 正则，或 Windows 上的 `legacy-shell`
  （回落到 `ComSpec ?? cmd.exe`）。shell 还必须是带盘符的完整路径，realpath 后等于 `%SystemRoot%` 下 System32 /
  SysWOW64 的 cmd.exe；裸名 `cmd.exe` 不认。POSIX 的 `legacy-shell` 是 `/bin/sh`，一律返回 false。
- 只接受白名单字符组成的单条简单命令；命令限 `dir`、`type`、`findstr`、`where`、git 只读子命令。
- 外部程序要求工作目录和 PATH 里位于工作区内的目录都没有同名程序、PATH 条目都是带盘符的完整路径（`C:\…`，不接受 UNC）；拒绝 UNC / `\??\` 路径和设备名。
- 判定不了一律返回 false，不放宽 prefix/wildcard allow，不影响 deny/ask 匹配和 guarded 危险命令判定。
- 测试需要模拟 Windows 时用 `setCmdReadonlyHostForTest`，用完传 `undefined` 恢复。

规则与白名单见 `apps/zcode-cli/docs/design/v2/tool/04-bash.md`「read-only Bash allowlist」；
运行时回归位于 `tests/bash-cmd-readonly-policy.test.ts`。
