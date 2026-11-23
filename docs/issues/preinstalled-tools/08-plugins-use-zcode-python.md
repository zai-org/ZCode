# 08 — 文档插件改用预装 Python

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

四个文档插件运行 Python 脚本和安装 Python 包时，先找 `zcode-python`，找不到再用 `python3`。现在还没有预装 Python，所以行为和以前一样。等 Python 资源就绪后，插件不需要再改。规则见 [Python 规格](../../preinstalled-tools/python.md#插件调用规则)。

- **说明文档**：SKILL.md、routes、references 等文档中的 Python 调用，统一写成 `"$(command -v zcode-python || command -v python3)"`。运行脚本、`-m pip install` 和统一入口的启动都要改。
- **脚本**：
  - Bash 的 setup 与 env_check 脚本，在开头解析一次 `PY`，后面全部用 `$PY`。
  - PowerShell 脚本先找 `zcode-python`，找不到再用原来的选择逻辑。
  - Python 代码中用 `sys.executable` 安装包的地方不改。
- **出问题时的规则**：各插件的 setup.md 写明预装 Python 出问题时怎么做：Agent 先说明原因，再让用户选择这一步改用自己的 Python，或关闭 Python 的开关。不自动回退。
- **工程门禁**：四个插件的 skills 和 scripts 中，除上面的表达式外，不能出现裸 `python` 或 `python3` 调用。门禁规则要写明怎样区分命令和普通文字。
- **版本**：四个插件升版，各处版本号保持一致。

## Acceptance criteria

- [x] 门禁通过；故意加入一处裸调用的用例被门禁拒绝。
- [x] CLI 测试（每个插件至少一个代表性命令，包括 env_check）：
  - PATH 上没有 `zcode-python` 时，命令使用 `python3`。
  - 放入一个假的 `zcode-python` 入口后，下一条命令使用它。
- [x] 统一入口按新写法启动，02 的统一入口回归测试仍然通过。
- [x] 远端和独立 CLI 打包的插件内容与桌面一致，行为与以前相同。

## Blocked by

- [02 — Agent 通过固定入口目录使用 LibreOffice](02-agent-bin-entry-libreoffice.md)

## 验证

- CLI：`pnpm --dir apps/zcode-cli typecheck`、`lint`，以及受影响包的测试，包括插件打包与 SEA 资产测试。
- 根目录 `pnpm lint` 与受影响的工程测试。

## Comments

- 2026-10-29：实现 commit `de9e495df942f296ae9e07a228ed3950419e1d1f`。四个插件的 Bash 命令、setup/env_check 与调用提示均优先选择 `zcode-python`；原生 PowerShell 示例和脚本通过 `Get-Command` 选择。已补齐 Python 失败恢复指引与对应 Skill 指针。documents/presentations/spreadsheets 升至 `0.2.6`，pdf 升至 `0.2.7`，package、插件 manifest、桌面 seed 与 SEA seed 版本一致。
- 已执行并通过：根目录 `pnpm typecheck`、`pnpm lint`（172 项既有警告、0 错误）、`pnpm architecture:check --changed`（0 violations）；`pnpm test:engineering scripts/check-document-python.test.ts scripts/check-document-libreoffice.test.ts`（8 项）；CLI `typecheck`、`lint`（71 项既有警告，另接纳 9 项原样上游行数诊断、0 错误）。CLI 两条检查在仓库根目录以 `PATH="$PWD/node_modules/.bin:$PATH" pnpm --dir apps/zcode-cli <命令>` 执行，补齐 hoisted Turbo 的命令查找路径。
- CLI 回归：`pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/document-python-entry.test.ts tests/preinstalled-tools.test.ts tests/libreoffice-entry.test.ts`（16 项）；`pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/plugins.test.ts`（48 项）；`node --test apps/zcode-cli/packages/cli/tests/sea-official-plugin-assets.test.mjs apps/zcode-cli/packages/cli/tests/build-sea.test.mjs`（45 项）。四插件实际 Bash 命令及三个 env_check 均覆盖先使用系统解释器、增加入口后下一条命令使用预装入口、入口运行失败时不自动改用系统解释器；02 的统一入口回归仍通过。
- 工程门禁已接入根 `pnpm lint`。已保留先失败、后通过的证据：分发目录中的旧命令、故意加入的裸调用、引号包围的裸解释器、Markdown 表格转义，以及插件版本不一致。Python AST、Bash 语法、四个 Skill 的元数据和新恢复链接、PowerShell 代码围栏的语法类型、`git diff --check` 均已核对；开源词检查 0 发现。
- 环境与失败记录：新 worktree 的两次 offline frozen install 在 hoisted vite/esbuild 的 rename 阶段报 ENOENT，没有修改锁文件；已安装的依赖可以运行检查。CLI typecheck 首次因 Turbo 不在 PATH 而未开始，补齐命令路径后通过。插件发现及 SEA 回归最初缺少新 worktree 的构建产物；补齐 model-option-map、node-repl-host、四文档插件、browser-use 和 zcode-site 产物后全部通过。原始失败与成功日志均保留在独立的 `preinstalled-tools-generic-20261029/08` 验证工件中，未改写首次结果。
- 未验证：原生 Windows PowerShell/cmd 执行留给 13；真实预装 Python、包安装与文档主流程留给 09、12。本票未运行桌面 E2E、未下载真实资源、未执行用户环境的依赖安装；以受控解释器替身验证命令选择边界。

- 2026-10-30 review 修正（`513191aa4a2`）：Python 两个来源都不存在时，三个插件的 9 个 Bash setup/env_check 入口和 3 个 PowerShell setup 在网络或安装动作前给出桌面预装提示并返回失败。四个 Skill 的入口先说明无解释器分支；setup.md 保留用户选择后的手动系统安装路径，解释器可见后可以继续，不要求移除桌面环境变量。presentations 没有独立 setup 脚本，补齐其说明中的手动步骤。无桌面变量时沿用原有引导。documents/presentations/spreadsheets 为 `0.2.7`，pdf 为 `0.2.8`，package、manifest、官方 definition 与 SEA seed 一致。
- 本次红绿与运行证据：9 个桌面缺失分支先失败后通过；CLI shell 用例包含 9 个 unmanaged 分支及 3 个 sourced/手动安装后恢复场景，28 项通过。受影响 adapters 合计 37 项、bootstrap 插件 48 项、SEA 45 项通过；工程门禁与 conda/catalog 合计 31 项通过。另用隔离 PATH/HOME 实际运行 18 次 Bash 并保留完整输出，没有移动或卸载宿主 Python，没有下载或安装真实资源。
- 本次根 `typecheck`、`lint`、架构检查及 CLI `typecheck`、`lint` 通过；根 172 项既有 warning、CLI 71 项既有 warning，均 0 error。CLI typecheck 33 个任务中 27 个命中缓存、6 个实际执行。Bash 语法、Skill 元数据与新增说明链接、PowerShell 前置分支和 UTF-8 BOM 已核对。原生 Windows PowerShell/cmd、其他平台、桌面回放与真实文档全链路本次未重跑；已有历史结果保持原范围，不扩大声明。
