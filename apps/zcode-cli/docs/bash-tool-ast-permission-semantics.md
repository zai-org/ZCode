# Bash Tool AST Permission Semantics

## 背景

Bash tool 的权限、只读和并发安全判断必须避免把动态 shell 结构当成普通只读命令。典型风险是 `ls $(touch out.txt)`：模型表面上调用 `ls`，实际 shell 会先执行命令替换里的 `touch`。

因此 Bash 权限链路需要基于 Bash AST 识别命令替换、进程替换、子 shell、pipeline、重定向等节点；复杂或不可安全归一的命令回到保守路径，不按简单只读命令自动放行。

## 第三方库选择

- `bash-parser` 提供 Bash AST，但最新 npm 版本仍是 `0.5.0`，发布时间较早，维护活跃度和现代 Bash 覆盖面不足。
- `tree-sitter` + `tree-sitter-bash` 的 AST 节点覆盖完整，但 Node 绑定是 native package；在当前仓库的 CLI 构建和跨平台安装链路中会引入额外 build/prebuild 风险。
- `web-tree-sitter` 已在 TUI 间接依赖中出现，但它是 WASM/web 绑定，不自带 Bash grammar；把异步 WASM 初始化放进核心权限判断会增加运行时复杂度。
- `unbash` 是维护中的纯 TypeScript Bash AST parser，0 依赖、同步 API，AST 能结构化区分 command/process substitution、redirect、assignment、pipeline、and/or 和 compound shell 节点，因此作为 Bash 权限语义的 parser 基础。

## 语义边界

- 权限相关判断先解析 AST，再提取安全的 top-level simple command argv。
- 遇到命令替换、进程替换、子 shell、函数、循环、条件、case、here-doc、解析错误或未知动态结构时，权限 matcher fallback open，read-only / concurrency-safe 返回 `false`。
- 简单只读自动 allow 不再只按命令名判断，而是采用 data-driven policy：先通过 AST 提取 simple command argv，再按命令级 `safeFlags` 校验 argv。`tree -a`、`tree -L 2` 这类只读参数可自动 allow，`tree -o out.txt` 这类写输出文件的参数不在 safe flags 内，必须回到正常审批路径。
- 展示分类仍可识别 top-level `cat`、`rg`、`find`、`ls > out.txt` 等 read/search/list 命令，但它只服务 UI / summary，不参与安全放行；`sed -i*`、`find -exec/-delete` 等写语义必须覆盖掉展示分类。

## Read-only policy 结构

Bash read-only 判定按多层 policy table 与执行器组合设计，而不是单一 allowlist：

- 主命令 safe flag policy：按命令声明允许的 flag 与参数类型，覆盖 `tree`、`sort`、`file`、`ps`、`date`、`fd`、`test` 等命令。
- 命令族子表合入主表：git 子命令、`rg`、`pyright`、`docker logs/inspect` 等命令族各自维护 safe flags。
- fallback allowlist 和 glob 分支：只有在命令结构、参数和动态特征都安全时才放行。
- 写入/执行选项拒绝表：拒绝 `find -delete/-exec/...` 这类会写入或执行的选项。
- 路径目标、读写类型、redirect 和 git internal path 等更宽的 permission 语义由独立层处理。

ZCode 当前先实现 Bash read-only auto-allow 所需的核心子集：AST 安全检查、simple command 限制、命令级 `safeFlags`、参数类型校验、短 flag 组合、`--flag=value`、`--` 处理、`find` 写语义拒绝。后续扩展其他命令时必须只改 policy table，不在执行器里追加命令名特判。

`sed` 的表达式属于另一套脚本语言；原来的 `-i` 和 `w` 黑名单漏掉了执行/写入形式。
只读判定改为完整脚本白名单，不使用危险指令黑名单。解析器只消费既有 AST argv：

- 选项仅允许 `-n/--quiet/--silent`、`-E/-r/--regexp-extended`、`--posix`、`-z/--zero-terminated`；
  短选项可以组合，选项必须在脚本前，可在脚本前用 `--` 结束选项。
- 打印要求 quiet：脚本仅由 `p`、`Np`、`N,Mp` 构成（地址为正整数），用分号连接，可带输入文件。
- 替换不接受 quiet、零分隔选项和文件参数：只处理标准输入，脚本必须完整匹配一条
  `s/pattern/replacement/flags`，只支持 `/` 分隔符及 `g/p/i/I/m/M` 与最多一个 `1–9` 标志。
  转义仅支持 `/`、反斜杠、`&`、`1–9` 和常见正则元字符 `. ^ $ * + ? ( ) [ ] { } |`；其他转义拒绝。
- 脚本中的控制字符、替换中的分号、未知选项、`-e/--expression`、`-f/--file`、`-i/--in-place`、
  脚本后的 option 形参数（单独 `-` 输入除外）、额外命令及执行/写入标志均拒绝自动放行。

子集外返回 `readOnly=false`、`concurrentSafe=false`：默认 Plan 拒绝，Build 请求审批。
管道、命令链、已支持 wrapper 和 Memory Agent 复用同一分类器。展示层的 `sed -i*` 识别保留，
已授权的普通 Bash 仍能执行原始 sed 命令。

2026-10-28 回归证据：Linux/GNU sed 下，真实 executor 与 NodeExecutionAdapter 在临时目录
复现了旧策略放行 `e`、替换命令的 `e`/`w` 标志并创建文件，且没有权限请求事件。
首次封堵移除 sed 只读资格后，同一组 Plan 调用只发出 PermissionDenied，不调用执行端、不创建文件；
Build 经审批仍可执行，cat/grep 继续自动放行。安全子集补充验收在 macOS/BSD sed 和
Linux/GNU sed 各通过 49 个真实执行链场景：安全打印与标准输入替换直接执行，危险或子集外
脚本在 Plan 下零执行、零文件改动；普通 Build 的 `-e` 打印经审批仍能执行。Windows 未实测。

### 压缩包查看、Windows 查询与 git 历史（2026-11-14）

Explore 子 agent 在 Plan 下常用的一批只读命令补进名单。同一份名单也决定 Build 是否免审批、
Memory Agent 能执行什么、前缀授权哪些段可以省略，所以每个形态都必须在任何参数组合下不写盘、
不联网、不执行其他程序：

- `unzip`：必须带 `-l`/`-v`/`-t` 之一；只收 `-q`、`-C`、`-O`/`-I <字符集>`。`-d`、`-o`、`-p`、`-x`、
  `-T`（改压缩包时间戳）都拒绝。Info-ZIP 没有长参数，`--` 不是参数结束而是「否定」标记
  （`unzip -l -- -l a.zip` 会取消列表模式并解压，2026-11-14 用 Info-ZIP 6.00 复现），所以 unzip、`unzip -Z`、
  zipinfo 里每个 `-` 开头的词都由回调按字符白名单整体校验：只能由该模式允许的字母组成（`-O`/`-I` 之后是字符集名），
  `-`、`--` 和 `:`、`^`、`$`、`/` 等其他字符一律拒绝。原因是通用参数表只把 `-[A-Za-z0-9_-]` 开头的词当选项检查，
  `unzip -:-l a.zip` 会被当成位置参数放过，而 Info-ZIP 把它解析成「开启 `:` 再取消 `-l`」并解压（同日复现）。
  `-O` 的值可以贴在后面（`-Olatin1`），值里的字母不算列表参数。
  `unzip -Z`（必须是第一个参数）与 `zipinfo` 共用 zipinfo 参数表，不收 `-M` 分页。
- `tar`：只放行列表模式（`-t`/`--list`），必须用 `-f`/`--file` 指定归档；支持旧式 `tar tzf a.tgz`
  和 `-tfa.tar`。只认 `t v z j J f` 与少量长参数（压缩格式、`--force-local`、`--wildcards`、
  `--exclude` 等），长参数不接受缩写。GNU tar 把「冒号前没有 `/`」的归档名当成 `host:path`
  远程归档，会解析主机名并调用 rsh；Windows 盘符 `D:\x.tar`、`D:/x.tar` 也命中（Git Bash 的 tar
  是 GNU tar），所以带冒号的归档名必须同时给 `--force-local`。
  例外说明：`-z/-j/-J/--zstd`（以及 GNU tar 对压缩归档的自动识别）会经 PATH 调用固定的解压程序
  （gzip、bzip2、xz、zstd），只做解压流、不写盘；可由命令指定程序的 `-I`/`--use-compress-program` 仍拒绝。
- `iconv`：不收 `-o`/`--output`。
- `xxd`：参数按前缀识别（`-r` 开头都是还原），只收精确的安全写法；xxd 在第一个文件名后不再解析参数，
  后面的词就是输出文件，所以最多一个位置参数。
- `command -v`/`-V`：只查名字解析结果。`command <程序>` 仍由 wrapper 剥离后按程序本身判定。
- Windows 查询：`dir` 同 `ls` 不限参数（CMD dir 和 GNU dir 都没有写入选项）；`findstr` 只认 `/` 开关，
  `/F:`、`/G:`、`/D:` 的值是 UNC 路径时拒绝；`where` 只认 `/R <目录>`、`/Q`、`/F`、`/T`；
  `whereis` 按参数表放行。三者都不接受 `-` 开头的未知参数。
- 不放行 `printenv`：它会把全部环境变量（含 API key、token）带进模型上下文，
  与需要审批的 `echo $TOKEN`、`env` 保持同一边界；只查单个变量同样可能读到密钥。
- git：`git --version` 只放行精确形态；`git log` 补 `--follow`、`-L`、`-i`、`--not` 等；新增 `git ls-tree`；
  `git grep` 补 `-r`、`-I`、`-m`、`-p`/`-W` 等，不收 `-O`（分页程序）和 `--textconv`。
  写入检查对 git 只看子命令之前的全局参数区：子命令之后的 `-c`/`-C`（`git grep -c` 计数、
  `git diff -C` 找复制）由子命令参数表判定。`git -C`、`cd && git` 仍拒绝。

通配符：策略只看得到 shell 展开前的 argv。`tar`、`unzip`（含 `unzip -Z`）、`zipinfo`、`iconv`、`xxd`
的只读结论依赖参数的形态和个数，任何一个词带未引用的通配符（`*`、`?`、`[...]`）就不算只读。
原因是展开后的文件名可能变成选项（`--checkpoint-action=exec=...` 让 tar 执行程序，`-o` 让 iconv 写文件），
也可能多出一个位置参数，被 xxd 当成输出文件。引号里的模式（如 `tar -tf a.tar '*.md'`）不受影响；
brace 展开在解析层已按动态词拒绝。2026-11-14 用 GNU tar 1.35 复现过 `tar -tf - *` 执行程序、
`xxd *.bin` 覆盖第二个文件。`findstr`、`where`、`dir`、`whereis`、`command -v` 没有写入或执行类参数，
不受此限制。

`tar` 和 `command` 的参数语法无法用 safe flag 表表达，与 `find`、`printf` 一样放在 direct argv 分支，
不改通用参数解析器。运行时选择 `cmd`/`legacy-shell` 时不使用本名单，改由 CMD 只读策略按 CMD 语法判定（见 04-bash.md）；
CMD 策略的 git 分支复用本名单的 `isGitReadOnlyCommand` 和 `hasDangerousGitGlobalOption`，所以 git 的新增形态
（含「写入检查只看全局参数区」）在 CMD 下同样生效；其余新命令只对 Git Bash 等 POSIX 方言生效。回归见 `core/tests/bash-permission.test.ts`。

## 项目级 command prefix 权限

command prefix registry 与本文件前述 readonly policy 是两个独立层：前者只决定用户选择
“始终允许此项目”时建议保存哪个 action scope，后者只决定一次 invocation 是否无需审批。
任何 prefix registry 命中都不能把命令提升为 readonly。

prefix resolver 复用同一份 `unbash` AST。安全 simple invocation 可借构建期 Fig registry
跳过已知 global option/value，并将 executable + 稳定 subcommand/action 保存为
`"<prefix>:*"`；path、URL、文件参数和 transient args 不进入 prefix。wrapper 最多两层，
保存时保留 wrapper 与用户原始 executable token。

以下情况统一保存 trim 后完整 command exact：解析失败、dynamic substitution、redirect、
未知 compound node、无法无歧义序列化的 token、动态 env assignment，以及没有稳定 action
边界的高风险 shell/删除/权限修改命令。compound command 的各需审批 invocation 独立生成
规则，最多五条；超过五条回退整串 exact。

匹配时先检查完整 raw exact，再对 AST-safe invocations 做 token-boundary prefix/wildcard
匹配。`allow` 只有在全部需审批 invocation 都被规则集合覆盖时成立；`deny`/`ask` 任一
invocation 命中即成立。因而 `npm run:*` 不得匹配
`npm run test && rm -rf ...`，但多条 allow rules 可以共同覆盖一个安全 compound command。

完整协议、存储和 UI 设计见
`docs/superpowers/specs/2026-07-13-bash-command-permission-registry-design.md`。
