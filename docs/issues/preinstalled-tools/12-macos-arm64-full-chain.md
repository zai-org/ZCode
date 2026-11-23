# 12 — 本机 macOS arm64 真实资源全链路验收

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

在本机用五个真实的 macOS arm64 资源，走一遍完整的用户流程：自动准备、Agent 在原会话中使用、切换开关、升级、删除。通过本票是开发阶段的交付门槛。

- 测试构建的 catalog 指向本地 loopback 服务，服务上放五个真实资源。
- 改写 real-loopback 候选，覆盖下列场景：
  - 自动准备的顺序为 Python → qpdf → Pandoc → Poppler → LibreOffice。
  - Bash 快照建立后才准备完成，原会话的下一条命令就使用预装版本（PT-13）。
  - 四个插件各跑一个主流程，都用 `zcode-python`（PY-01）。
  - 用真实的 Word、PPT、中文样例和公式工作簿做转换与重算（LO-02、LO-03、LO-05）。
  - pdf2image 使用预装的 `pdftoppm`（PP-03）。
- 每个工具都先关闭再打开开关（PY-02、PP-05、PD-02、QP-02、LO-06）。
- 把一个工具升级到新的 `resourceId`（PY-07 或其他工具）；然后逐个删除工具。
- 引导与回退：
  - LibreOffice 预装失败后重跑一次（LO-07）。
  - 预装和系统都不可用时给出引导（LO-08、PT-15）。
  - 系统已装有工具时使用系统版本（PT-16）。
- 更新 [用例目录](../../conversation-session-case-catalog.md) 和覆盖矩阵。把每个资源实测的下载字节数和安装字节数写进对应工具规格的“体积”一节。

## Acceptance criteria

- [x] real-loopback 候选回放通过。证据记录 App 版本、每个资源的 `resourceId` 和系统架构。候选保持待审核。
- [x] 上面列出的每个场景都有通过证据。没有覆盖到的场景如实列出，不写成通过。
- [x] 调用前后，应用签名都有效；用户默认的 LibreOffice 配置没有变化（LO-04、LO-09 中能在本机验证的部分）。
- [x] 用例目录、覆盖矩阵和工具规格中的体积都已更新。

## Blocked by

- [04 — 升级时保留旧版本与启动清理](04-upgrade-and-startup-cleanup.md)
- [05 — 每个工具的“Agent 使用预装版本”开关](05-agent-use-switch.md)
- [08 — 文档插件改用预装 Python](08-plugins-use-zcode-python.md)
- [09 — Python 资源](09-python-resource.md)
- [11 — Poppler 资源](11-poppler-resource.md)

## 验证

- 在本机 macOS arm64 上回放桌面 E2E 候选，按 [E2E 用例生命周期](../../../.agents/skills/e2e-case-lifecycle/SKILL.md) 保存证据，不转正。
- 失败的批次保留原始记录；重跑成功不能改写成首次通过。

## 验证启动边界

本候选先独立启动真实 App，再让 ChromeDriver 连接，下载屏障保证资源在连接后才完成安装。单一 runner owner 负责启动、失败收尾、退出和重启；沿用现有 Electron bridge 与退出屏障，其他候选默认行为不变。该方式基于本机 driver 启动上下文与独立启动的对照；未证明内核阻塞或 provenance 属性的因果，不删除属性、不放宽资源运行检查、不替代 13 的原生安全验收。

## Comments

- 本票只修改验收夹具、runner 的本用例启动隔离及用例/规格记录，不修改产品安装、开关、改写、签名策略或检查时限。旧 session 重复删除不能结束新 App；操作闭包绑定 browser，避免 config/spec 的不同 loader 实例各自保存 owner。
- 起点为集成提交 `bd0fb4404a5eda124c646ed679cb58abf4485be3`，开工及提交前 freshness 通过，提交前核对集成未前进。候选保持 `manual-review/pending`，未转正；正式 catalog 保持原状态。
- GUI 补验使用真实系统 LibreOffice、独立测试 profile 与文档副本。原生 UI 的中文未保存标记、可见窗口、完整 AX 文本及 PID 在并行调用前后保持，前后均出现保存修改提示。实际分发 documents/xlsx 0.2.6 的两条 managed native 操作重叠 47 个采样，两份私有 profile 重叠 52 个采样；PDF 一页且中文完整，工作簿缓存为 18/#DIV0。临时 profile 全部清理，真实默认 profile 在被测调用前后 71 文件集合/摘要一致，两份应用严格签名前后有效。证据保存在任务 artifacts 的 `12/gui-coexist-native/`。
- GUI 清理副作用单独保留：退出验收 GUI 后再取 AX，工具意外启动了使用默认 profile 的空 StartCenter。它只新增 `.lock` 和 22 个图标缓存，原 71 文件没有变化。按核对的 PID、启动时间和路径只终止该新实例，备份新增文件并核对 SHA、设备/inode 后删除这 23 个精确路径；只清除确认本次新建的 14 个空目录。原文件从未重写，最终文件集合/摘要恢复，没有残留 soffice，应用签名有效。`recovery-before.json`、`recovery-result.json`、父代理独立复核及备份均保留，不把副作用抹成“从未发生”。
- 初次失败保留：首轮被 WDIO 外层 120 秒预算截断；随后 driver 启动上下文中 Poppler 的 10 秒检查失败，采样位于 dyld 加载/库验证阶段。独立启动及连接后放行对照通过，未删除安全属性、未放宽检查；provenance 与内核耗时的因果仍未证实。owner 跨 loader 的空实例由运行日志证明，显式绑定 browser 后真实重启与完整回放通过；旧 bridge 的 WeakMap 未改。
- 一次缓存审计错误地把 PDF/xlsx 脚本既有的 `sys.dont_write_bytecode=True` 当成入口默认值，已分别记录启动前 False 与执行后真实值，并以全新默认入口导入 16 包及执行 pip，严格核对预装区文件集合/摘要。工程检查另捕到响应已结束但源文件尚未 close 的计数竞态，改用响应 finish/close 单次结算；正常结束、提前断开及活动数归零均有回归。
- GUI 首次 UNO 控制器的系统 LibreOffice 自带的 Python SDK 入口被 SIGKILL（137），并非 GUI或转换失败；改用原生 UI 取证，没有修系统 Python或改安全设置。首次并行操作成功，但采样器误用旧 `macro:///` 过滤；按现行 `vnd.sun.star.script:` 修正后，用新无缓存工作簿重验，原记录保留。
- 未验证：其他平台与 macOS 13/15 原生首次运行/安全弹窗；Python 专属升级附加区重置（本票按约定选择 qpdf 升级）；生产安装包身份、法务、CDN 和正式 catalog 发布。01、13、14 未实施。

### 实现与最终验证

- 实现 commit：`08a0b87330269c81cbab5cac3ca3ce5874a7b9d7`（`test(preinstall): verify real five-tool workflows`）。
- 已执行并通过：根 `pnpm typecheck`（包含 E2E 类型项目）、`pnpm lint`（172 条既有 warning、0 error）、`pnpm architecture:check --changed`（0 violation）；受影响工程四文件 23/23，覆盖真实 HTTP 完成/中断、owner 身份与跨加载实例绑定、既有重启/bridge 边界。候选 fixture 校验、E2E 类型校验、当前改动格式、相对文档链接及 diff 检查通过。旧格式检查的 Pandoc 文档失败保留，修正后最终格式检查通过。
- CLI 自身入口已执行：`pnpm --dir apps/zcode-cli typecheck`，33/33 成功且全部为 Turbo 缓存命中，日志回放旧 worktree 路径不表示在旧目录执行本次命令；`pnpm --dir apps/zcode-cli lint`，0 error、71 条既有 warning及 9 条原样上游行数接纳。adapters 的预装环境、LibreOffice/Python 入口与 MCP 网络测试 19/19，bootstrap 的真实 MCP/Hook 环境测试 1/1。
- 最终完整候选 `desktop-e2e-20261029-192126-373` 1/1 PASS，143.3 秒；此前完整 attempt06 也为 PASS，之后仅修复 HTTP 夹具账本并以最终源码重建桌面产物重放。启动重启边界 `desktop-e2e-20261029-185358-964` 及原默认启动 upgrade `desktop-e2e-20261029-190953-866` 均 PASS。所有候选仍 pending。实际旧进程树退出、Host 收尾与新 PID 有证据；原始终止信号收据保留，不写成 App exit0。
- 源码包版本 3.16.3、Electron 44.7.0；default-App 的 `app.getVersion()` 原值是 44.7.0，已与产品源码版本分字段记录。运行基线 HEAD、当时未提交的测试源码及 App/CLI 产物 SHA 均保留，未将 WIP 验收冒称只对应基线提交。
- 五资源依次准备，完整原会话四插件与开关阶段保持 Agent PID 97105；升级阶段重启 App 后，qpdf r1/r2 两次实际执行保持新的 Agent PID 3590。预装 Python 23003 条目（21787 文件/链接）在默认缓存导入和真实 pip 附加包安装后严格一致；旧 qpdf 在后续真实 App 启动回收，五工具经 UI 全部删除。最终中文 PNG 与已逐张查看的同资源页面逐字节一致。
- 开源自查 0 竞品词发现；提醒器保留 2 条既有提示（历史覆盖矩阵 private-signing、已有内部工作流命令），本票未新增这两项。没有 push、MR、远端 issue 或 CDN 发布。
