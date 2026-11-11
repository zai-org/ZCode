# Office 文件预览

## Feature Summary

| 字段       | 内容                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| 变更       | Preview Pane 新增 Excel 与 Word（`.docx` / `.doc`）只读预览                                   |
| 用户入口   | 工作区文件树、文件链接和其他会生成 `CodeViewerSource` 的文件预览入口                          |
| 渲染库     | `@extend-ai/react-xlsx@^0.16.0`、`docx-preview`；旧二进制 `.doc` 兼容路径保留 `@extend-ai/react-docx` |
| 状态所有者 | 文件字节由 workspace-scoped `fileService` 读取；解析和预览状态由当前 Preview Pane 持有        |
| 范围外     | Office 文件编辑、保存、导出、密码解密、跨端预览状态同步                                       |

## 入口路由：`.xlsx` 优先分流到内置查看面板

`.xlsx` 在可用环境中不再进入 Preview Pane，改由内置 `spreadsheets@zcode-plugins-official`
插件的查看面板打开（`docs/plugins/2026-10-15-office-viewer-builtin-panels-spec.md` §9）；
`.xlsm` / `.xls` 与所有回退路径继续使用本文的 Preview Pane 渲染。

- 分流点是 UI 打开入口（文件管理器 `navigate` 与 `code-viewer` 打开回调），不是 `PreviewPane`
  内部；路由表数据驱动（扩展名 → pluginId + surfaceId），不把插件身份散落到各调用点。
- 插件清单声明的文件查看器（`file.viewer`）排在 `.xlsx` 常量之后、Preview Pane 之前，复用本节的
  能力门、严格相对化、实例 tab 与 `open_document` 投递，见 [扩展进程](../plugins/extension-host.md) §16.5。
- 文件归属以 source 自带的工作区三元组优先（与旧链路按 source 归属读取一致）；source 属于
  其他 workspace（含本地跨工作区）、工作区外路径或 `..` 越界时回退 Preview Pane，路径严格
  相对化失败（null）绝不退化成文件名——`open_document` 以当前工作区为根解析，文件名会
  静默打开工作区内同名的另一份文件。
- 能力门（任一不满足即静默回退 Preview Pane，不打扰用户）：
  - desktop 本地 workspace：非远程 workspace、无 `remoteSessionId`、平台具备 `pluginSandbox`；
  - `pluginUiBridgeService` 可用，且 `mcp/pluginsListUiSurfaces` 能解析出该 surface；
  - 当前聚焦 pane 有有效 session（面板 tab 以它为 `parentSessionId` 作用域）。
- 打开动作：复用 `openPluginUiSidePane`，每个文件一个独立面板实例 tab
  （`instanceId = file:<workspace 相对路径>`，与启动器手动入口的独立窗口同一机制）。不同 `.xlsx` 并存为
  多个 tab，互不覆盖；同一文件重复打开按确定的 tab id 去重，聚焦已有 tab 并重新加载该文件。
  tab 标题显示文件名，不设数量上限，由用户自行关闭。实例 tab 不接收 Agent 的
  `open_document` / `show_in_viewer` 结果（那些仍路由到无实例的 surface tab）。
- 文档加载：宿主等待该 surface 的页面实例进入 `running` 后，以面板实例身份调用
  `open_document`（workspace 相对 posix 路径），成功结果经面板通知通道回投，面板按既有
  快照逻辑加载；此通路对插件运行时零改动。
- 失败回退：surface 解析失败、面板就绪超时、`open_document` 返回错误时，回退打开
  Preview Pane `code-viewer` tab（旧链路），并记录 UI logger warn。回退不主动关闭已打开的
  面板 tab。
- 边界保持：`.xlsm` / `.xls` / `.csv` 与 Word / PPTX / PDF 预览不受分流影响；批量打开入口
  （一次多个 source）不做分流。

## 文档内容安全边界

Office 文件属于不受信任内容。任何 DOCX/XLSX/PPTX/旧 DOC/PDF renderer 都不得把文档中的
URL 原样交给主 renderer 的 DOM 导航或脚本执行路径。

- 外部链接只允许 `http:`、`https:`；文档内部只允许经过校验的 `#anchor`。
- `javascript:`、`data:`、`vbscript:`、`file:`、`blob:`、控制字符混淆和协议编码变体必须被拒绝。
- renderer 仍需在生成 DOM 后对 `a[href]` / `a[xlink:href]` 做防御性扫描，并观察异步新增节点与属性；图片等非交互资源的 `href` 不得被误删。
- DOM 观察器初次安装时扫描完整预览根节点；后续 mutation 只扫描变更属性的目标或 `addedNodes` 子树，不得因第三方 renderer 分批挂载或虚拟化重挂载而对整个文档重复全树扫描。
- PDF 预览当前强制 `renderAnnotationLayer={false}`，因此链接注解不会进入主 renderer DOM；若未来启用 annotation layer，必须先在 PDF 挂载点接入同一链接净化与受控外链回调，不能仅依赖 pdf.js 默认导航行为。
- 当前第三方 Office renderer 没有统一的 relationship 拦截接口，因此 DOM 门禁是强制收口；后续若 parser 暴露 Target hook，应复用同一白名单前置拒绝。
- 未来若 renderer 需要保留文档内链接交互，应放入无 preload、无 Node、禁止导航/弹窗的 sandbox iframe；主 renderer 不得直接承载第三方文档脚本。
- 外链打开必须走受控回调；不能把不可信 `href` 直接传给 `window.zcode` 或 `shell.openExternal`。

### 内置预览的已知注入与外链绕过修复

内置预览保持现有承载与只读行为。本次修复已知入口，不把主窗口声明为文档沙箱：

- PPTX 气泡图 tooltip 的系列名和数值必须按文本转义后再插入 HTML；图例保留原始文本。依赖补丁覆盖应用使用的 browser 入口，预览与 PDF 打印共用该入口。
- XLSX 的单元格、形状、图片外链必须共用 `onOpenLink` 回调，经 `sanitizeDocumentHref` 校验后调用现有 `onOpenBrowserUrl`。回调拒绝时不回落到 `window.open`。工作表内部定位继续由查看器处理。
- Desktop 主窗口的原生 popup 一律拒绝创建；合法 HTTP(S) 请求转发到现有 Browser 打开事件，危险协议不转发。嵌入浏览器和 MCP App guest 保持各自现有策略。
- 不修改文件读取、监听、保存权限或预览状态 owner；Desktop 和 Web 的 XLSX 复用同一受控回调。

```text
XLSX 单元格 / 形状 / 图片 → 同一外链回调 → URL 白名单 → 现有 Browser 打开入口
主窗口原生 popup         → Main 拒绝建窗 → HTTP(S) 才转发 Browser 打开事件
PPTX tooltip            → 动态字段转义 → HTML 只包含静态格式和文本
```

| Case  | 场景与断言                                                                                                                          | 状态             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| OPS01 | 打开包含 HTML 系列名的真实 PPTX 并悬浮气泡；tooltip 显示字面文本，不生成攻击节点，不执行标记脚本；打印路径使用相同修复              | covered：本轮通过，文件保留 pending |
| OPS02 | 真实 XLSX 的单元格、形状、图片点击危险协议，既不调用原生 `window.open`，也不打开 Browser；合法 HTTP(S) 仍路由，内部工作表跳转仍可用 | failing：Canvas 前置超时，后续断言未执行 |
| OPS03 | 主窗口直接请求危险协议 popup，主窗口地址与原生窗口数量不变；HTTP(S) 转入 Browser，仍不创建原生窗口                                  | covered：本轮通过，文件保留 pending |

候选 E2E：`packages/desktop/test/e2e/ui-shell/panels/manual-review/pending/office-preview-security.test.ts`。

2026-11-10 转正回放：`packages/desktop/.e2e-artifacts/desktop-e2e-20261110-091822-523`，
OPS01/03 通过，OPS02 在等待 XLSX Canvas 显示时超时（30 秒）。单元格、形状、图片外链与
工作表跳转断言未执行；根因尚未确认。人工复核已确认，但整份文件仍保留 pending。
2026-10-29：macOS Electron 候选回归 3/3 通过（包含真实 PDF 文件导出），运行 ID：
`desktop-e2e-20261029052945936-p62112-8df77f872a16aa7f`。候选保持待人工复核，不自动转正或加入 CI。
同一 XLSX 组件在浏览器宽屏 / 手机尺寸 × 深 / 浅主题下验收通过：每组 7 次危险链接均到达拦截入口，
HTTP、HTTPS 和工作表内跳转正常；PPTX browser 入口与打印渲染也通过。未验证 Windows、Linux、实体手机或真实远控链路。

安全回归必须覆盖协议白名单、编码/控制字符绕过、DOCX 真实 hyperlink relationship，以及 Desktop 主 renderer 点击后的人工验收。
同时必须锁定 PDF annotation layer 关闭状态，并验证异步新增链接只净化变更子树而不重复扫描整个预览根节点。

## Impact Brief

### UI Surface Matrix

| 用户场景                            | UI 入口                                              | 共享实现                                                          | 展示 / 草稿 owner                                            | 校验 / gating                                    | 提交动作                                                                 | 权威来源                                       | 模式边界                                                                  | 必须隔离                                                              |
| ----------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 从 workspace 打开 Word / Excel 文件 | 工作区文件树、文件链接和其他 `CodeViewerSource` 入口 | `PreviewPane` → `PreviewPaneContent` → `PreviewPaneOfficeContent` | 当前 Preview Pane 的读取、解析、缩放和错误 state；无持久草稿 | 扩展名路由、25 MB 二进制读取上限、解析器错误边界 | 只读调用 workspace-scoped `fileService.readBinaryPreview`；无写入 commit | 当前 workspace 中 `source.path` 对应的文件字节 | Desktop / Web / 远程 workspace 共用 service 注入；预览 state 不进入消息流 | task/session、desktop continuous、web remote replayable、其他预览 tab |

### Shared And Divergent Behavior

| 关注点     | 共享                                                               | 有意不同                                                                        | 对本次替换的意义                                      |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 文件读取   | 所有 Office 类型使用同一受限二进制读取和 base64 RPC 返回           | 无                                                                              | 不修改 file service、workspace identity 或 25 MB 上限 |
| 路由与错误 | `PreviewPaneOfficeContent` 统一懒加载、空白 loading 和本地化错误态 | `.xlsx`、`.docx`、`.doc` 进入独立 renderer chunk                                | `.docx` 可替换实现而不影响 Excel 或旧 `.doc`          |
| 渲染       | 都是只读 Preview Pane 内容                                         | `.docx` 用 `docx-preview`；`.doc` 用 legacy `react-docx`；Excel 用 `react-xlsx` | `docx-preview` 不支持 OLE `.doc`，必须显式分流        |
| Excel 多表 | Excel workbook 共用同一个只读 controller                          | ZCode 自定义 sheet 导航只展示可见 workbook tab，不启用库的编辑/导出 toolbar   | 多表切换不能以重新解析文件或开放写入能力为代价        |
| DOCX 分页  | 页面必须保留 OOXML section 边界及各自页边距                        | 使用 `docx-preview` 官方默认的 section 分组行为；不额外启用 `lastRenderedPageBreak` | 同尺寸 section 也可能拥有不同页边距，禁止合并        |
| 响应式     | Word 预览共用 `calculateDocxPreviewFit` 的只缩小不放大规则         | DOCX 测量生成的 HTML wrapper；legacy `.doc` 测量 editor 画布                    | 保持桌面窄侧栏和小屏布局语义                          |
| 生命周期   | source 切换时清理当前可见内容                                      | DOCX 的 `renderAsync` 无取消 API，使用 detached DOM + active guard              | 旧异步结果不能覆盖最新文件                            |

### Feature Relationships

| Rank           | From                            | Semantic edge             | To                                         | 条件 / 原因                      | 证据                                        |
| -------------- | ------------------------------- | ------------------------- | ------------------------------------------ | -------------------------------- | ------------------------------------------- |
| must-inspect   | Office file preview             | renders-in                | Preview Pane Office surface                | 唯一用户可见入口                 | `PreviewPane.tsx`、`previewPaneContent.tsx` |
| must-inspect   | Preview Pane Office surface     | reads-through             | workspace binary preview service           | Office 解析需要完整受限字节      | `PreviewPane.tsx`、`fileService.ts`         |
| must-inspect   | DOCX surface                    | renders-with              | `docx-preview.renderAsync`                 | 仅 `.docx`                       | `previewPaneOfficeDocxContent.tsx`          |
| conditional    | legacy Word surface             | renders-with              | `@extend-ai/react-docx`                    | 仅 OLE `.doc` 兼容路径           | `previewPaneOfficeLegacyDocContent.tsx`     |
| invariant-only | Preview Pane local render state | must-remain-isolated-from | desktop continuous / web remote replayable | 预览不是 task runtime 或恢复状态 | 架构约束 + UI 本地 state                    |
| evidence-only  | Office preview implementation   | covered-by                | unit + runtime + build smoke               | 不声明新的产品依赖               | `officeFilePreview.test.ts`、Verification   |

### State Owners And Commit Sinks

| 状态 / 事实                        | 展示 owner                     | 权威 owner                  | command / service          | 持久化       | 证据                  |
| ---------------------------------- | ------------------------------ | --------------------------- | -------------------------- | ------------ | --------------------- |
| Office 文件字节                    | `PreviewPane`                  | 当前 workspace file service | `readBinaryPreview`        | 无新增持久化 | `PreviewPane.tsx`     |
| DOCX 生成 DOM、loading、error、fit | `PreviewPaneOfficeDocxContent` | 当前挂载的 Preview Pane     | `docx-preview.renderAsync` | 无           | component + unit test |
| 文件类型                           | `getOfficeFilePreviewKind`     | source path 扩展名          | 无 commit                  | 无           | helper test           |

### Must-Preserve Invariants

| 不变量                                                                 | Surface / 模式                             | 证明                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `.docx` 不再进入 `@extend-ai/react-docx`；`.doc` 不进入 `docx-preview` | Desktop / Web / local / remote             | 路由 helper 与两个独立 lazy chunk 的单测、生产构建产物 |
| source 切换后旧 `renderAsync` 结果不可提交到可见 DOM                   | 所有 DOCX 预览                             | stale render component test                            |
| 相邻同尺寸 section 必须渲染为独立页面，并使用各自的 `pgMar`           | 所有 DOCX 预览                             | 真实双 section fixture + renderer regression test      |
| DOCX 白纸页面使用低对比度浅阴影，不使用 renderer 默认的 50% 黑色阴影 | light / dark / Zai Light / Zai Dark        | page surface style component test + CDP computed style |
| 预览不读取本机同路径替代 remote workspace 文件                         | SSH / WSL / Docker / Web                   | 继续复用既有 workspace service wiring                  |
| 预览 state 不进入 task/session snapshot 或消息流                       | desktop continuous / web remote replayable | 无协议、store、main、relay 变更                        |
| 文档内容保持白纸和自身颜色，外层只使用语义主题 token                   | light / dark                               | runtime screenshot + `DESIGN.md` 检查                  |

### Codegraph Evidence

当前会话未提供 codegraph 工具，因此按 skill fallback 使用精确 symbol 文本扫描验证直接调用方，展开深度为 2。

| Seed                           | 查询           | 直接调用方 / 路径                                  | 深度 | 结论                                            |
| ------------------------------ | -------------- | -------------------------------------------------- | ---- | ----------------------------------------------- |
| `getOfficeFilePreviewKind`     | direct callers | `PreviewPane.tsx`                                  | 1    | 扩展名只决定 Preview Pane Office 路由           |
| `PreviewPaneOfficeContent`     | direct callers | `previewPaneContent.tsx`                           | 1    | Office UI 只有一个共享分发入口                  |
| `PreviewPaneOfficeDocxContent` | direct callers | `previewPaneOfficeContent.tsx` dynamic import      | 1    | DOCX renderer 可独立替换和分包                  |
| `readBinaryPreview`            | direct callers | `PreviewPane.tsx`                                  | 2    | 不需要改 service / RPC / workspace identity     |
| Office preview tests           | affected tests | `officeFilePreview.test.ts`、`previewPane.test.ts` | 2    | 覆盖路由、render options、错误恢复、stale guard |

### Graph Drift And Delta

| 状态            | 节点 / 边                                                                                                 | 原因                                   | 动作                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| confirmed drift | 原图缺少 Office file preview capability / surface / local render owner / binary preview service           | live code 和已有 spec 已存在该产品能力 | 已补充 `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` |
| confirmed delta | Office surface reads through workspace file service，并与 desktop continuous / web remote replayable 隔离 | 本次替换保持既有边界                   | 已写入节点、edge、code seed；YAML 完整性和 seed 文件检查通过                         |

### Unresolved Questions

无。用户已明确 `.docx` renderer 目标；`.doc` 保持既有能力是由新库格式边界和现有产品 contract 共同确定的兼容决策。

### Planning Handoff

| 项目                    | 目标                                                                         | 状态       |
| ----------------------- | ---------------------------------------------------------------------------- | ---------- |
| Spec update             | 本文                                                                         | complete   |
| Case catalog / coverage | 本文 `Candidate Combinations`、`Accepted Cases`                              | complete   |
| Decision backlog        | 无未决产品语义                                                               | complete   |
| E2E handoff             | 不涉及 conversation/session；component + Web runtime + production build 足够 | not-needed |

## Boundary Decisions

| 边界          | 决策                                                                                                                                                                                      | 原因                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Excel 扩展名  | 支持 `.xlsx`、`.xlsm`、`.xls`；`.xlsx` 是完整支持路径，`.xlsm` / `.xls` 按渲染库的有限解析能力展示                                                                                        | `react-xlsx` 官方声明主要支持 OOXML `.xlsx`，旧格式只展示底层解析器能够读取的数据                                         |
| 入口分流      | 仅 `.xlsx` 参与插件面板分流；`.xlsm` / `.xls` 永远走 Preview Pane 旧渲染                                                                                                                   | 插件声明 `office.kinds: ["xlsx"]`，旧格式交给插件只会得到 `unsupported_type` 错误                                           |
| Word 扩展名   | OOXML `.docx` 使用 `docx-preview` 的稳定 `renderAsync` API；旧二进制 `.doc` 继续使用 `@extend-ai/react-docx` 的只读 editor viewer                                                         | `docx-preview` 面向 ZIP/OOXML DOCX，不能解析 OLE `.doc`；分开路由既替换问题较多的 DOCX 渲染链路，也不回退已有 `.doc` 能力 |
| 交互模式      | 统一只读；不暴露编辑、保存、复制粘贴或导出能力                                                                                                                                            | Preview Pane 的产品职责是展示，不拥有文件写入语义                                                                         |
| 文件来源      | 继续使用当前 source 的 `workspacePath`、`workspaceIdentity`、`workspaceRemoteSessionId` 解析 workspace-scoped `fileService`                                                               | 保持本地、SSH / WSL / Docker、独立 Web 和手机远控共享同一服务边界                                                         |
| 文件读取      | 新增通用、受限的二进制预览读取接口，以 base64 跨 RPC 返回完整文件；上限为 25 MB                                                                                                           | Office ZIP / OLE 解析需要完整字节；避免 UI 直接访问 Node 文件系统，也避免无限制跨进程传输                                 |
| 加载方式      | Office 渲染组件和第三方库按文件类型懒加载；Excel WASM 作为构建资产加载                                                                                                                    | 避免普通文本/图片预览承担 Office 解析器体积和初始化成本                                                                   |
| 加载反馈      | 文件读取、懒加载和解析期间保持空白预览面，只保留不可见的 `aria-busy` 状态，不显示“正在加载 Office 文件预览”文案                                                                           | 实际加载时间很短，文字闪现会制造不必要的视觉跳变                                                                          |
| 主题          | Excel 接收当前 light/dark 主题；DOCX 保持纸张白色与中性页面间隙，暗色主题只改变外层工作区                                                                                                 | 文档自身颜色属于内容语义，不能被应用主题任意改写                                                                          |
| Excel 多表    | 保持 `showDefaultToolbar={false}`，通过 `toolbar` render prop 只渲染可见 workbook tab；选择 tab 时调用同一 controller 的 `setActiveTabIndex`                                             | 默认 toolbar 同时承载 sheet tabs 和编辑/下载动作；预览只需要多表导航，不能为了显示 sheet 而重新开放写入或导出入口         |
| Excel ZIP 路径 | 接受 ZIP entry 使用非标准 Windows 反斜杠分隔符的 `.xlsx`，由 `react-xlsx@0.16.0` 在统一读取边界归一化后解析                                                                               | 部分 Excel 写入器会生成 `xl\worksheets\sheet1.xml` 一类 entry；旧版会把可恢复文件误报为缺少必需 part                      |
| 页面层级      | DOCX 页面复用原 `react-docx` 浅色纸张阴影 `0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)`，覆盖 `docx-preview` 默认 50% 黑色阴影                         | 纸张是普通内容 surface，不是 overlay；低对比度阴影可区分页面与背景且不会形成过重黑边                                       |
| 响应式        | 预览根节点填满 Preview Pane；Excel 表格在自身容器内滚动；DOCX 在 `renderAsync` 完成后测量生成的页面包装层，宽度不足时等比缩小到容器可用宽度，容器变宽后实时重算，但不放大超过文档原始尺寸 | 桌面与手机 Web 不改变功能语义，同时避免纸张原始像素宽度撑破 Preview Pane                                                  |
| DOCX 分页     | `ignoreLastRenderedPageBreak` 保持 `docx-preview` 官方默认值 `true`；相邻 section 即使纸张尺寸相同，也必须分别生成页面并应用各自的 `pgMar`                                                     | `docx-preview@0.4.0` 在该选项为 `false` 时会合并没有显式 page break 且纸张尺寸相同的 section，导致后续正文沿用封面零边距 |
| DOCX 安全边界 | 禁用 `altChunk` HTML 渲染，图片和字体使用 base64 URL；切换文件或卸载时丢弃过期渲染结果并清空生成 DOM                                                                                      | Preview 文件可能来自不受信任的 workspace；避免把嵌入 HTML 注入 renderer，也避免异步完成的旧文档覆盖当前文件               |
| 错误          | 文件缺失继续使用现有弱提示；超限、解析失败和格式损坏显示本地化错误态，同时用 UI logger 记录一次失败                                                                                       | 保持 Preview Pane 现有错误层级并提供可诊断证据                                                                            |

## Domain Scope

| Domain                               | 是否包含 | 说明                                                                            |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------- |
| File / workspace service             | 是       | 二进制文件必须通过依赖注入后的 workspace service 读取                           |
| UI shell / theme / responsive / i18n | 是       | 新增渲染容器、加载态、错误态和中英文文案                                        |
| Rendering / performance              | 是       | Office 依赖和解析按需加载，文件传输受 25 MB 上限保护                            |
| Workspace identity / remote runtime  | 是       | 隔离继续使用 `workspaceIdentity?.trim() \|\| workspacePath`，文件路径只用于读取 |
| Session / task realtime              | 否       | 预览是 UI 本地状态，不进入 continuous 或 replayable 消息流                      |
| Persistence                          | 否       | 不保存页码、sheet、缩放或 Office 文档状态                                       |

## Candidate Combinations

| ID     | 文件 / 环境                        | 操作                 | 预期结果                                                          | 状态                     |
| ------ | ---------------------------------- | -------------------- | ----------------------------------------------------------------- | ------------------------ |
| OFP-01 | 本地 `.xlsx`                       | 从文件树打开         | 读取完整字节并显示只读 workbook，可切换 sheet                     | accepted                 |
| OFP-02 | 本地 `.docx`                       | 从文件树打开         | 通过 `docx-preview.renderAsync` 显示只读分页文档                  | accepted                 |
| OFP-03 | `.xlsm` / `.xls`                   | 从文件树打开         | 尝试显示底层解析器支持的数据；失败进入统一错误态                  | accepted                 |
| OFP-04 | SSH / WSL / Docker / Web workspace | 打开 Office 文件     | 使用对应 workspace-scoped `fileService`，不读取本机同路径         | accepted                 |
| OFP-05 | 手机窄屏或较窄的桌面 Preview Pane  | 打开 Office 文件     | DOCX 生成页面按可用宽度等比缩小且无横向溢出，滚动时能访问最后一页 | accepted                 |
| OFP-06 | 文件超过 25 MB                     | 打开                 | 拒绝跨 RPC 读取并显示本地化超限错误                               | accepted                 |
| OFP-07 | 文件损坏、加密或解析器不支持       | 打开                 | 显示本地化不可预览错误，不影响其他 tab                            | accepted                 |
| OFP-08 | 普通文本、Markdown、SVG、图片      | 打开                 | 保持原渲染和菜单行为                                              | accepted                 |
| OFP-09 | 旧二进制 `.doc`                    | 从文件树打开         | 读取完整字节并通过 Word 只读渲染链路显示分页文档                  | accepted                 |
| OFP-10 | Office 文件编辑/保存               | 在 Preview Pane 操作 | 不提供该能力                                                      | pruned：超出只读预览职责 |
| OFP-11 | 任意受支持的 Office 文件           | 打开预览             | 加载期间保持空白，不闪现可见 loading 文案；完成后直接显示内容     | accepted                 |
| OFP-12 | 封面零边距、正文有页边距的双 section DOCX | 打开预览         | 生成两张独立页面；正文保留自己的左右页边距，不被封面 section 合并 | accepted                 |
| OFP-13 | ZIP entry 使用反斜杠的 `.xlsx`            | 打开预览         | 归一化 entry 路径并正常显示 workbook，不进入文件损坏错误态        | accepted                 |
| OFP-14 | 本地 `.xlsx`，插件面板可用                | 文件树 / 文件链接打开 | 打开 spreadsheets 面板 tab 并自动加载该文件；不创建 `code-viewer` tab | accepted                 |
| OFP-18 | 先后打开多个不同 `.xlsx`，或重复打开同一个 | 打开                 | 每个文件各占一个面板 tab，晚返回的加载结果不覆盖其他 tab；同一文件聚焦已有 tab | accepted                 |
| OFP-15 | `.xlsx`，远程 workspace / web / 无沙箱 / 无有效 session | 打开      | 静默回退 Preview Pane 旧渲染，行为与分流前一致                    | accepted                 |
| OFP-16 | `.xlsx`，`open_document` 失败或面板就绪超时 | 打开            | 回退打开 `code-viewer` tab，logger.warn 留痕；面板 tab 不强制关闭 | accepted                 |
| OFP-17 | source 归属其他 workspace、工作区外绝对路径或 `..` 越界的 `.xlsx` | 打开 | 分流的严格相对化返回空并回退 Preview Pane；绝不把路径退化成文件名交给 `open_document`（否则会在当前工作区静默打开同名文件） | accepted                 |

## Accepted Cases

| Case ID | Setup                           | Action                     | Assertions                                                                                                | Evidence                                                         | 自动化状态 |
| ------- | ------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- |
| OFP-01  | 小型多 sheet `.xlsx`            | 打开文件预览并切换 sheet   | 识别为 Excel；调用二进制读取；显示所有可见 sheet 名；选择后调用 `setActiveTabIndex` 并更新活动 sheet；不显示编辑/导出工具栏 | UI helper + component interaction test + CDP runtime             | covered    |
| OFP-02  | 含段落的 `.docx`                | 打开文件预览               | 识别为 DOCX；调用二进制读取；以安全选项调用 `docx-preview.renderAsync`                                    | UI helper + component test + CDP runtime                         | covered    |
| OFP-04  | source 带 remote workspace 参数 | 打开文件预览               | 继续把 workspace 三元组交给 `useWorkspaceServices`                                                        | 现有 Preview Pane wiring + regression test                       | covered    |
| OFP-05  | DOCX 原始纸张宽度大于预览容器   | 打开、调整宽度并滚动到底部 | 缩放比例为 `min(1, 可用宽度 / 原始宽度)`；包装层宽高与 transform 使用同一比例；容器无横向溢出且末页可访问 | component test + CDP scaled-scroll regression                    | covered    |
| OFP-06  | 大于 25 MB 的二进制文件         | 读取预览                   | service 在读取前拒绝，不返回文件内容                                                                      | service unit test                                                | covered    |
| OFP-07  | 非法 Office 字节                | 渲染预览                   | parser 错误被错误边界转换成可读错误态                                                                     | component test                                                   | covered    |
| OFP-08  | 现有文本 / 图片 source          | 打开预览                   | 仍走既有分块文本或媒体路径                                                                                | existing tests                                                   | covered    |
| OFP-09  | OLE Compound Document `.doc`    | 打开文件预览               | 识别为 legacy Word；调用二进制读取；只在该兼容路径交给 `react-docx` 解析                                  | UI helper + PreviewPane routing test + real parser/runtime smoke | covered    |
| OFP-11  | Office 文件读取或解析尚未完成   | 打开文件预览               | 空白预览面带 `aria-busy`，不渲染可见 loading 文案                                                         | component test                                                   | covered    |
| OFP-12  | 两个同尺寸、不同页边距的 section | 打开文件预览               | `docx-preview` 生成两个 `section`；第二页使用正文 `pgMar`，不沿用封面 `padding: 0`                         | real DOCX renderer regression + CDP runtime                      | covered    |
| OFP-13  | 必需 OOXML part 使用反斜杠 ZIP entry | 打开文件预览             | `react-xlsx` controller 解析完成，无 `Missing required part` 错误且生成 worksheet tab                     | real renderer integration test                                  | covered    |

## Implementation Contract

- `packages/shared` 声明通用二进制预览返回类型；`IFileService` 暴露受大小限制的读取方法。
- `packages/services` 在 `stat` 后、`readFile` 前检查大小，默认和硬上限均为 25 MB。
- `packages/ui/src/PreviewPane.tsx` 只负责识别、读取生命周期和错误归一化；Office 渲染放在独立模块。
- Office 文件不能先进入 `readTextFile` 的 binary fallback；切换 source 时必须丢弃旧请求结果。
- 第三方渲染器必须动态加载。Excel viewer 必须显式 `readOnly`，WASM 必须由 Vite / Electron 可用的相对构建资产提供。
- Excel renderer 必须使用 `@extend-ai/react-xlsx@^0.16.0` 或更高兼容版本，确保非标准反斜杠 ZIP entry 在 worker、主线程和 deferred load 共用的读取边界完成归一化。
- Excel 必须保留 `showDefaultToolbar={false}`，避免开放编辑、保存和导出入口；多 sheet 导航必须通过 `toolbar` render prop 读取 `controller.tabs`，并用 `controller.setActiveTabIndex` 在同一 workbook controller 内切换，不能只展示首个 sheet，也不能为切换 sheet 重建或重新解析 workbook。
- `.docx` 与 `.doc` 必须继续绕过 `readTextFile` 并通过受限二进制读取接口取得完整字节；不能因 `.doc` 可能含可提取文本而回退代码预览。
- `.docx` 必须调用 `docx-preview.renderAsync`，不得再进入 `@extend-ai/react-docx` 的 model/editor 链路。渲染选项必须关闭 `renderAltChunks`、关闭 debug，并使用 base64 URL；只允许当前 source 的异步结果提交到可见 DOM。
- `.docx` 不得把 `ignoreLastRenderedPageBreak` 覆盖为 `false`；必须保留 `docx-preview` 官方默认的 section 分组行为，确保同尺寸 section 仍独立分页并应用各自页边距。
- `docx-preview` 生成的页面必须覆盖其默认 `0 0 10px rgba(0, 0, 0, 0.5)` 阴影，统一使用原 `react-docx` 浅色纸张阴影；不得按应用暗色主题把白纸页面改回深阴影。
- 旧二进制 `.doc` 单独保留 `useDocxEditor` + `DocxEditorViewer mode="read-only"` 兼容路径；不得把该兼容路径重新用于 `.docx`。
- DOCX 必须保留文档原始排版比例，只在生成页面宽度超过容器可用宽度时缩小；缩放后的占位宽高必须同步更新，不能只使用 `transform` 留下未缩放的滚动区域。
- Office 加载阶段不得显示可见 loading 文案；空白态继续通过 `aria-busy` 暴露给辅助技术。
- 新增样式只使用 `DESIGN.md` 的语义 token，并同时验证 Zai Light、Zai Dark 和窄屏。
- UI 错误日志统一使用 `packages/ui/src/logger.ts`，不得直接调用 `console`。

## Verification

- service unit：正常 base64、默认/自定义大小限制、目录拒绝。
- UI unit：扩展名识别、Excel 多 sheet 名称与切换交互、Excel 默认编辑 toolbar 关闭、反斜杠 ZIP entry 的真实 Excel 解析、`.docx` / `.doc` 分流、Office 文件不显示代码换行菜单、加载与错误分支、`renderAsync` 安全选项、同尺寸双 section 分页与页边距、DOCX 浅色页面阴影、旧 `.doc` 只读 props。
- Desktop runtime：打开真实多 sheet `.xlsx`，验证 sheet tab 全部可见、点击后活动 sheet 内容切换且无重新读取文件。
- Web runtime：使用 `docx-preview` 官方 `page-layout` DOCX fixture 打开真实预览；794px 原始纸张在 422px Preview Pane 内缩放为 `0.531486`，可见 DOM 无 alert，浏览器无 page error。
- build smoke：Desktop renderer 与 Web production build 都能解析 Office 包、worker 和 Excel WASM 资产。
- repository gates：`pnpm typecheck`、`pnpm lint`。
