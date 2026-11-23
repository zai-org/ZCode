# 15 — Python 资源裁剪：删除测试目录，只编译 0 级字节码

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)。规则见 [Python 资源规格](../../preinstalled-tools/python.md)的“资源内容”一节。

## 背景

Windows Defender 实时防护扫描每个新写入的文件。13 的 Defender 日志显示，一次完整安装写出约 43,400 个文件，累计扫描 460～500 秒。Python 资源在 Windows 上解包约 2.4～2.7 分钟，见 [13](13-other-platform-verification.md)。

2026-11-04 核对 `python-3.12.16-20261026-win32-x64-r1`：

| 内容                                          | 文件数     | 展开大小   |
| --------------------------------------------- | ---------- | ---------- |
| 全部                                          | 23,286     | 520 MB     |
| `.opt-1.pyc`、`.opt-2.pyc`                    | 9,538      | 174 MB     |
| site-packages 中的 `tests` 目录（不含上一行） | 3,235      | 59 MB      |
| 按新规则剩下                                  | **10,513** | **286 MB** |

- `tests` 目录共 19 个，都在 site-packages 中，属于 pandas、numpy、matplotlib、mpl_toolkits 和 pip 内置的 certifi。资源中没有标准库的 `test/` 目录。
- 测试目录外引用 `tests` 的只有两处，都不影响运行，见规格。
- 插件、入口和运行检查都不用 `-O` 或 `-OO` 运行 Python。

## What to build

- 转换器在编译字节码之前，删除预装区 site-packages 中名为 `tests` 的目录，并从对应 `RECORD` 去掉这些文件的条目。资源描述的 `provenance.removedTests` 逐项列出删除的目录、文件数和字节数。
- 字节码只编译优化级别 0。字节码记录的 `optimizationLevels` 变为 `[0]`。
- 检查：删除步骤遍历整个 site-packages，不留下 `tests` 目录。字节码审计原有的“没有未审计的 pyc”检查不变，残留的 `.opt-1.pyc`、`.opt-2.pyc` 会让制作失败（上游 PBS 包只带 0 级 pyc）。“每个能编译的 `.py` 都有对应的 0 级 pyc”不变。
- 六个目标的 recipe 资源身份从 `-r1` 升为 `-r2`。内容变了，不能沿用原 resourceId。
- recipe 中的声明（架构例外、上游路径前缀等）若指向被删除的文件，按通用规格打包失败；删除对应声明后再制作。
- 同步更新 `scripts/preinstalled-tools/python/README.md` 中的字节码说明。

## Acceptance criteria

- [x] 工程测试先补、先失败：删除 `tests` 目录（`testing`、`_testing`、`test` 保留）、`RECORD` 同步、制作记录、只生成 0 级缓存。改实现后通过（Windows；POSIX 布局用例已在 macOS arm64 执行通过，见“macOS arm64 记录”）。残留 opt pyc 由字节码审计原有的“未审计 pyc”检查拒绝，本票未新增用例。
- [x] Windows x64 重新制作 `-r2`：满足 PY-12；按 13 的第 4 层重跑 real-loopback 通过；记录 Python 解包耗时，与 `-r1` 的 2.4～2.7 分钟对比。见“Windows x64 记录”。
- [x] macOS arm64 重新制作 `-r2`：满足 PY-12；按 [12](12-macos-arm64-full-chain.md) 的流程重跑主要场景。见“macOS arm64 记录”。
- [x] 其他目标在 13 中产出时直接使用新规则。新规则写在转换器中（`layout.mjs`、`precompile.py`），六个目标的 recipe 都已是 `-r2`，之后在任何平台制作都按新规则执行，不需要另外的步骤。
- [x] 规格“体积”一节换成 `-r2` 的实测数字。

## Windows x64 记录

2026-11-04，Windows 11 家庭版 build 26200，x64，与 13 的第 4 层同一台机器，Defender 实时防护开启。提交 `bdafbb0929`。

**制作**：`python-3.12.16-20261026-win32-x64-r2`，两次制作的 `.tar.gz`、`.artifact.json`、`.bytecode.json` 逐字节相同。

| 项目                 | `-r1`       | `-r2`                                                              |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| 普通文件数           | 23,286      | 10,513                                                             |
| 归档字节数           | 163,392,376 | 104,928,844                                                        |
| 安装字节数           | 519,876,327 | 285,738,435                                                        |
| 归档 SHA-256         | —           | `787009cdd6268ca32bbe896d1aa8883c52e73359d172cd66163e3704b0ff9a85` |
| `optimizationLevels` | `[0, 1, 2]` | `[0]`                                                              |
| `removedTests`       | —           | 19 个目录，1,749 个文件，24,555,382 字节                           |

PY-12：归档中没有 `tests` 目录，也没有 `.opt-1.pyc`、`.opt-2.pyc`。

**第 4 层 real-loopback**（Python 用 `-r2`，其余四个资源与 13 的第 10、11 次相同）：

| 次  | 结果                                                                                                      | 证据                                                    |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 12  | 失败：环境问题。主仓库目录没有构建 Windows 入口 shim，五个工具都报“缺少 Windows 入口 shim”，与 `-r2` 无关 | `desktop-e2e-20261104031408905-p7668-d4b0e58fe911ea8d`  |
| 13  | 通过（用例 11 分 22 秒）。构建 shim 后重跑，shim 与 worktree 中的逐字节相同                               | `desktop-e2e-20261104032512269-p10072-7dba50e5772a734e` |

解包耗时（预装进程日志中 `extracting` 到 `checking` 的间隔）。LibreOffice 资源没有变化，作为对照：

| 次  | Python 资源 | Python 解包 | LibreOffice 解包 | 用例耗时    |
| --- | ----------- | ----------- | ---------------- | ----------- |
| 10  | `-r1`       | 138 秒      | 138 秒           | 14 分 11 秒 |
| 11  | `-r1`       | 146 秒      | 135 秒           | 13 分 36 秒 |
| 12  | `-r2`       | 60 秒       | 未到达           | 失败        |
| 13  | `-r2`       | 57 秒       | 132 秒           | 11 分 22 秒 |

- Python 解包从约 2.4 分钟降到约 1 分钟，减少约 59%。下降比例与文件数的下降比例（55%）接近。
- 下载阶段的耗时受 E2E 下载屏障控制，不代表真实下载时间，不作比较。

## macOS arm64 步骤

在 Mac（arm64）上做。Windows x64 由 Windows 侧另做，两边可以同时进行。

1. 拉取 `feat/preinstalled-tools-python-trim` 分支，安装依赖。
2. 跑工程测试，全部通过。POSIX 布局用例（`prepares a relocatable overlay…`）在 Windows 上跳过，只在这里执行：

   ```sh
   pnpm test:engineering scripts/preinstalled-tools/python scripts/preinstalled-tools/common/inputs.test.ts
   ```

3. 用 `python-darwin-arm64.json` 制作两次，每次用新的输出目录（放在仓库外），输入目录沿用 12 的缓存：

   ```sh
   node scripts/preinstalled-tools/python/convert.mjs \
     --recipe scripts/preinstalled-tools/python/recipes/python-darwin-arm64.json \
     --input-dir <输入缓存> --output-dir <输出目录-a>
   ```

   两次的 `.tar.gz` 字节数和 SHA-256 必须相同。

4. 核对 PY-12：
   - `tar -tzf <r2>.tar.gz | grep -cE '/tests/|\.opt-[12]\.pyc$'` 输出 `0`。
   - `.artifact.json` 中 `provenance.bytecode.optimizationLevels` 为 `[0]`；`provenance.removedTests` 列出删除的目录。
   - 记录 `-r1` 与 `-r2` 的文件数、归档字节数和安装字节数。
5. 按 [12](12-macos-arm64-full-chain.md) 回放 real-loopback 候选 `conversation-session/manual-review/pending/conversation-session-preinstalled-tools-real-loopback.test.ts`：
   - `ZCODE_E2E_MANUAL_REVIEW=1`。
   - `ZCODE_E2E_PREINSTALL_ARTIFACTS` 指向一个 JSON 数组文件，按 Python、qpdf、Pandoc、Poppler、LibreOffice 的顺序列出五个描述路径。Python 用新的 `-r2`。qpdf、Pandoc、LibreOffice 沿用 12 的 darwin-arm64 资源。Poppler 用同一归档按现行规则生成的描述 `timeouts-20261030/poppler/poppler-26.10.0-darwin-arm64-r2.artifact.json`，运行检查时限为 60 秒。12 列表中的 Poppler 描述 `11/resources/mac-r2-first` 还是旧的 10 秒时限，不要沿用（见“macOS arm64 记录”中 attempt-01、02 的失败原因）。
   - `ZCODE_E2E_PREINSTALL_UPGRADE_ARTIFACT` 沿用 12 的 qpdf 升级资源。
   - `ZCODE_E2E_DOCUMENT_PYTHON`、`ZCODE_E2E_DOCUMENT_SAMPLES`、`ZCODE_E2E_LIBREOFFICE_SYSTEM_APP`、`ZCODE_E2E_LIBREOFFICE_DEFAULT_PROFILE` 与 12 相同。
   - 运行：`pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-preinstalled-tools-real-loopback.test.ts`。
   - 失败批次保留原始记录，重跑通过不能写成首次通过。
6. 把结果写进本票的“macOS arm64 记录”一节，并把 `-r2` 的下载字节数和安装字节数写进 [Python 规格](../../preinstalled-tools/python.md)的“体积”一节。内容包括：资源 SHA-256 与字节数、两次制作是否一致、PY-12 结果、E2E 证据目录名与结果、Python 从开始解包到 ready 的耗时。
7. 交付 `.artifact.json`、`.tar.gz`、`.bytecode.json` 和制作日志，用于发布。

## macOS arm64 记录

2026-11-04，本机 macOS 26.5.2（25F84）arm64。分支 `feat/preinstalled-tools-python-trim`，HEAD `bdafbb09292b8ce54930852d4d149c640794701b`，freshness 通过。证据保存在任务 artifacts 的 `15/`。

### 工程测试

- `pnpm test:engineering scripts/preinstalled-tools/python scripts/preinstalled-tools/common/inputs.test.ts`：5 个文件、15 个用例全部通过。
- POSIX 布局用例 `prepares a relocatable overlay and constrains every preinstalled distribution` 在本机执行并通过，没有跳过（verbose 日志 `15/logs/engineering-verbose.log`）。

### 制作与重复性

- 输入沿用 09 的输入缓存 `09/inputs`，没有新下载。两次制作分别输出到 `15/resources/mac-a`、`15/resources/mac-b`，各用 80 秒、69 秒，退出码都是 0。制作日志 `15/logs/convert-mac-{a,b}.log`。
- 两次的三个文件逐字节一致：

| 文件             | 字节数    | SHA-256                                                            |
| ---------------- | --------- | ------------------------------------------------------------------ |
| `.tar.gz`        | 115169488 | `50e1a962b7f53bfe50b349c2596d2d99616cb51adef3018f8f9bf7ca7f816fbd` |
| `.artifact.json` | 44324     | `b3f6bc6b4dd39f985773bfa21eef687d51159865afca52e2b8163ef30980428c` |
| `.bytecode.json` | 685887    | `003b0a6bb9f79d6c465fa9107494a229a17360e3c232cd8691002ead58957cfb` |

- resourceId 为 `python-3.12.16-20261026-darwin-arm64-r2`。交付文件为 `15/resources/mac-a` 中的三个文件与上述制作日志。

### PY-12

- `tar -tzf <r2>.tar.gz | grep -cE '/tests/|\.opt-[12]\.pyc$'` 输出 `0`。
- `provenance.bytecode.optimizationLevels` 为 `[0]`。3242 个源文件全部编译，失败 0 个。
- `provenance.removedTests` 列出 19 个目录，共 1,747 个文件、24,369,350 字节：pandas 1 个（1,143 个文件）、numpy 13 个、matplotlib 1 个、mpl_toolkits 3 个、pip 内置的 certifi 1 个。
- 运行检查：E2E 四个批次中 Python 都通过运行检查，到达“安装发布完成”。
- PY-01：attempt-04 中通过。四个插件都通过 `bin/zcode-python` 运行，pptx 检查的解释器是 `-r2` 附加区的 `overlay/bin/python`，公式为 `C1=5`、`D1=#DIV/0!`，pdf2image 使用预装的 `pdftoppm`（`15/attempt-04/real-document-results/main.json`）。attempt-03 的主流程断言也通过，但该批次后续步骤失败。
- 安装后的预装区 `python/` 共 10,017 个条目（9,086 个文件、6 个链接、925 个目录），没有 `.opt-1.pyc`、`.opt-2.pyc`，site-packages 中没有 `tests/`（`python-base-before.json`）。默认缓存设置下导入 16 个包、并在附加区用 pip 安装探针包之后，预装区的文件集合和摘要都没有变化（`finish.json` 的 `pythonBaseUnchanged: true`）。所以只编译 0 级字节码没有遗漏默认运行要用的缓存。
- PY-12 在 macOS arm64 上满足。

### `-r1` 与 `-r2` 对比

`-r1` 为 09 的 `09/resources/mac-first-final`，`-r2` 为本次 `mac-a`。条目数来自归档。

| 项目                            | `-r1`       | `-r2`       |
| ------------------------------- | ----------- | ----------- |
| 归档条目                        | 23,325      | 10,339      |
| 其中普通文件                    | 21,923      | 9,228       |
| 其中目录                        | 1,393       | 1,102       |
| 其中符号链接                    | 9           | 9           |
| `.pyc`                          | 14,190      | 3,242       |
| `.opt-1.pyc`、`.opt-2.pyc`      | 9,460       | 0           |
| site-packages `tests/` 下的条目 | 6,502       | 0           |
| 归档字节数                      | 173,350,995 | 115,169,488 |
| 安装字节数                      | 544,706,594 | 311,814,470 |

### E2E（real-loopback）

- 输入：Python 为本次 `-r2`，qpdf、Pandoc、Poppler、LibreOffice 与 qpdf 升级资源沿用 12；`ZCODE_E2E_DOCUMENT_*`、`ZCODE_E2E_LIBREOFFICE_*` 与 12 相同。运行脚本 `15/scripts/run-e2e.sh`，环境记录 `15/logs/attempt-NN.env.txt`。四次都在 HEAD `bdafbb09292`，工作区只有本节两份文档的改动。

| 批次       | 启动方式                            | run ID                                                  | 结果     | 用例耗时 | Python 解包 → ready（解包 + 检查） | 失败点                     |
| ---------- | ----------------------------------- | ------------------------------------------------------- | -------- | -------- | ---------------------------------- | -------------------------- |
| attempt-01 | Agent 会话（iTerm2 中的 CLI）       | `desktop-e2e-20261104032449454-p60436-188c8039dd309a10` | **FAIL** | 79.4 秒  | 51.2 秒（6.4 + 44.8）              | Poppler 运行检查 10 秒超时 |
| attempt-02 | 用户在 iTerm2 的 shell 中直接运行   | `desktop-e2e-20261104033927821-p19074-ca56561d85646ea6` | **FAIL** | 72.0 秒  | 47.0 秒（5.3 + 41.7）              | Poppler 运行检查 10 秒超时 |
| attempt-03 | 用户在 Terminal.app 的 shell 中运行 | `desktop-e2e-20261104034806849-p52875-cb39f13ed4d63aac` | **FAIL** | 64.7 秒  | 6.4 秒（5.3 + 1.1）                | python-on 重开对话框被遮挡 |
| attempt-04 | 用户在 Terminal.app 的 shell 中运行 | `desktop-e2e-20261104035907600-p4613-48f7f9ab00810c6f`  | **PASS** | 113.9 秒 | 7.2 秒（6.1 + 1.2）                | —                          |

- 首次完整通过的是 attempt-04，前三次失败的记录都保留，不写成首次通过。
- attempt-01 启动时另一个会话正在运行 E2E。脚本等它在 03:24Z 结束后才开始，两者没有同时运行。attempt-02～04 启动时没有其他 E2E。
- attempt-01、attempt-02 的失败点相同：
  - Python `-r2`、qpdf、Pandoc 依次就绪。
  - Poppler 的运行检查 `pdftoppm -v` 在 10 秒时失败，`errorKind: runtime`。Poppler 资源与 12 相同，本票没有改它。10 秒时限来自 12 的旧描述，原因见下面的“attempt-01、02 中 Poppler 超时的原因”。
  - 四个插件、开关、升级、删除场景都没有执行。原始日志为 `15/logs/attempt-0{1,2}.log`，两次失败的 HOME 都已保留。
- attempt-03：
  - 五个工具按 Python、qpdf、Pandoc、Poppler、LibreOffice 的顺序就绪。Python 检查 1.1 秒，Poppler 检查 0.1 秒。
  - 主流程通过（见上面的 PY-01）。
  - 关闭 Python 后的下一条命令通过：插件的解释器选择落到系统 `/Library/Developer/CommandLineTools/usr/bin/python3`，五个工具的 `installation.json` 没有变化（`python-off.json`）。这是 PY-02 的前一半。
  - 失败点：测试在 03:50:23.007 点击 Python 的开关。03:50:23.043 状态已变为关闭。03:50:23.044 测试发出 Escape。03:50:23.784 测试重新打开对话框，点击帮助菜单时被 `data-state="open"` 的 `dialog-overlay` 挡住（`element click intercepted`）。
  - 现有日志和快照没有记录 dialog 的状态，所以不能确定是 Escape 没有关闭预装工具对话框，还是另一个 dialog 打开了。开关在命令执行期间为 `disabled`（`PreinstalledToolsDialog.tsx` 的 `disabled={pending}`），Escape 发出时命令可能还没有返回。这一点只是待验证的线索，不是结论。
  - 这一段测试逻辑在 12 之后没有改。12 的 attempt-05～07 都通过了这一段。attempt-04 在同样条件下也通过了这一段，所以这是偶发失败，没有复现，原因没有确认。
  - 开关、升级、删除的其余场景没有执行。原始日志为 `15/logs/attempt-03.log`，失败的 HOME 已保留。
- attempt-04 完整通过，覆盖 12 的主要场景：
  - 下载顺序为 Python、qpdf、Pandoc、Poppler、LibreOffice，之后是 qpdf 升级。共 6 次请求、6 次完成，同时最多 1 个传输。Python 检查 1.2 秒，Poppler 检查 0.1 秒。
  - 原会话：Bash 快照建立后才放行下载；同一个 Agent 进程完成主流程、五个工具的关/开和收尾检查（`main.json`、`<tool>-off.json`、`<tool>-on.json`、`finish.json` 中的 `agentPid` 相同）。
  - 主流程见上面的 PY-01。Word 和 PPT 转出的 PNG 已逐张查看，中文完整，没有缺字或裁切，与 attempt-03 的 PNG 逐字节一致。
  - 开关：五个工具都先关后开（PY-02、QP-02、PD-02、PP-05、LO-06）。关闭 Python 后插件的解释器选择落到系统 `python3`，打开后恢复为 `-r2` 的 `overlay/bin/python`。
  - 附加区：探针包装进 `overlay/` 的 site-packages（`addon.json` 为 `overlay-only`），预装区不变（见上面的 PY-12）。
  - LibreOffice 回退与引导：预装失败后落到系统 LibreOffice 并实际运行一次，取消后不重试，临时配置目录都已清理，无工具时给出引导文字（`fallback-results.json`）。
  - 升级：App 重启后 qpdf 从 `-r1` 升到 `-r2`，前后都能运行；旧 qpdf 在下一次 App 启动时回收（`deletion-evidence.json` 的 `oldQpdfRemovedOnAppRestart: true`）。
  - 删除：五个工具经 UI 全部删除，状态都为 `not-installed`（`five-tools-deleted.png`）。
  - 收尾：应用签名前后都有效；用户默认的 LibreOffice 配置没有变化（`finish.json`）。
  - 独立启动的 App 共 3 个进程（PID 10886、18098、19139），对应两次真实重启。三份退出记录都是 SIGKILL，与 12 的记录方式相同，不写成正常退出。
  - 原始日志为 `15/logs/attempt-04.log`，证据目录为 `15/attempt-04/`。通过的批次不保留 HOME。
- Python 从开始解包到 ready 的耗时：
  - `-r1`（12 的通过批次 attempt-05～07）：12.6～19.9 秒，其中解包 11.5～18.0 秒。12 的全部批次中解包为 11.5～18.2 秒。
  - `-r2`（本票 Terminal.app 下的 attempt-03、04）：6.4～7.2 秒，其中解包 5.3～6.1 秒。本票四个批次的解包都在 5.3～6.4 秒。
  - iTerm2 下的 attempt-01、02 走的是首次检查的慢路径（见下一项），Python 检查用 41.7～44.8 秒，不计入对比。这两次 Python `-r2` 都在 180 秒时限内通过检查。
- attempt-01、02 中 Poppler 超时的原因：
  - 时限来自旧描述。本票步骤 5 要求其余四个资源沿用 12，12 的列表中 Poppler 描述是 `11/resources/mac-r2-first`，运行检查 `timeoutMs` 为 10000。`6efaff26adc` 已把 Poppler 运行检查时限改为 60 秒，同一归档（SHA-256 `9e30c3c8…`）按新规则生成的描述是 `timeouts-20261030/poppler`，`timeoutMs` 为 60000。所以这两次失败来自验收输入，不是现行产品的时限。
  - 首次检查是否慢，取决于启动 E2E 的终端程序在系统设置“隐私与安全性 → 开发者工具”中有没有授权。同一个 Poppler 归档，每次解包到新目录后测首次 `pdftoppm -v`（脚本 `15/scripts/time-poppler-first-run.sh`）：

    | 测量                                     | 启动方                             | 开发者工具授权        | 首次 `pdftoppm -v` |
    | ---------------------------------------- | ---------------------------------- | --------------------- | ------------------ |
    | `diagnostic-poppler-tar{,-2}.txt`        | Agent 会话（iTerm2）               | 无                    | 21.8 秒、18.0 秒   |
    | `diagnostic-poppler-tar-3.txt`           | Agent 会话（iTerm2，授权后未重启） | 已授权，iTerm2 未重启 | 19.6 秒            |
    | `poppler-first-run-terminal-01.txt`      | Terminal.app                       | 有                    | 0.137 秒           |
    | `poppler-first-run-iterm-restart-01.txt` | iTerm2（授权后重启）               | 有                    | 0.113 秒           |

  - 四个 E2E 批次与此一致：iTerm2 无授权的 attempt-01、02 中 Python 检查用 41.7～44.8 秒，Poppler 超过 10 秒；Terminal.app 有授权的 attempt-03、04 中 Python 检查用 1.1～1.2 秒，Poppler 用 0.1 秒。
  - iTerm2 授权后不重启，仍然慢；授权并重启后变快。所以授权要在 iTerm2 重启后才生效。没有单独测“只重启、不授权”。Terminal.app 一直有授权，所有测量都快。据此判断授权是决定因素。系统内部的机制没有核对。
  - 授权并重启后，进程链仍经过 `iTermServer-3.7.2`（不在 iTerm.app 包内），检查也快。所以 iTermServer 不影响授权生效。
  - `com.apple.provenance` 不是决定因素：iterm-restart-01 解包出的 `pdftoppm` 带这个属性，首次仍为 0.113 秒；terminal-01 的不带，也快。Terminal.app 写出的文件有时带、有时不带（attempt-03 的 `.env.txt` 带，attempt-04 的不带），原因没有核对。之前“文件带属性时首次执行慢”的推测不成立。
  - 本 worktree 的 Electron 带这个属性，与 12 记录的 Electron 不同。attempt-03、04 用同一个 Electron 也快，所以它不是决定因素。
  - 12 中由 ChromeDriver 拉起 App 时失败、改为独立启动后通过，可能也是同一个条件（App 的负责进程不同）。没有验证。
  - 对用户的影响：用户从 Finder 或 Dock 打开 ZCode 时，一般走慢路径。慢路径的耗时已写在通用规格的运行检查一步，现行时限（Python 180 秒、Poppler 60 秒）覆盖了它。attempt-01、02 也说明 Python `-r2` 在慢路径下能通过检查。通过的 attempt-04 走的是快路径。
  - 本票没有删除属性，没有放宽检查时限。

- 未验证：macOS 13/15 真机首次运行（PY-10）；Python 专属的升级（PY-07，本票与 12 一样用 qpdf 升级）。候选保持 `manual-review/pending`。

## Blocked by

无。资源进入正式 catalog 仍按 [14](14-release-cdn-and-catalog.md) 处理。

## Comments

- 2026-11-04：用户审阅通过规格。macOS arm64 一起重新制作和验收；本票不做签名。
- 2026-11-04：用户决定去掉“记录 Defender 日志中的扫描累计时间”这项验收，解包耗时的对比已足够说明效果。
- 2026-11-04：验收完成，关票。另发现 11 记录的 darwin-arm64 Poppler 最终描述仍是 10 秒时限的旧描述，已在 [11](11-poppler-resource.md) 的 Comments 中改为 60 秒的新描述，不属于本票的改动。
- 如果之后要给 Windows 资源的程序签名，也会改变归档和 resourceId。签名方案确定前先做本票；两件事可以合并为一次重新制作和验收，由用户决定。
