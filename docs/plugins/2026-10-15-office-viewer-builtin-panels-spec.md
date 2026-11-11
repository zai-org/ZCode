# 内置文档插件查看面板规格：documents / pdf / presentations / spreadsheets 0.2.0

> 日期：2026-10-15
> 状态：已实现，桌面端真机验证待补
> 关联：插件仓库测试市场已发布同名插件 0.2.0（含查看面板）；本次把面板并入随应用发布的内置插件。

## 1. 背景与决策

四个文档插件是随应用发布的内置插件（`zcode-plugins-official`），插件 ID 为 `<name>@zcode-plugins-official`。插件仓库的 CDN 目录若发布同名条目，合并目录会以 CDN 条目展示，但运行时发现先加载内置副本、同 ID 的市场安装被判为重复忽略，内置插件也不参与市场更新。因此查看面板不能从插件仓库单独发布，必须随内置插件升级。

决策：

- 四个插件统一升到 0.2.0，在原有生产技能之外新增一个查看技能（`docx-viewer`、`pdf-viewer`、`pptx-viewer`、`xlsx-viewer`）、一个 stdio MCP server 和一个 `availability: "session"` 的 UI surface。
- 面板实现放在共享包 `@zcode/office-runtime`（`apps/zcode-cli/packages/office-runtime`）。每个插件在 package.json 的 `office` 字段声明面板标题与格式，`build` 脚本调用 `../office-runtime/scripts/build.mjs`，只打包该格式的解析器与查看器。
- `read_document`、`search_document` 服务面板里的讨论：返回的位置是面板使用的锚点，可直接交给 `show_in_viewer`；PDF 文字与面板文字层经过同一套归一（§6.3），可作为 `quote` 高亮。Excel 例外：没有缓存结果的公式在 server 文字里没有值，面板会计算并显示（见 `xlsx-viewer` 技能）。工具描述写明这一用途，要求先 `open_document`，并把面板之外的提取与处理指向同格式的生产技能（`docx` / `xlsx` / `pptx` / `pdf`）。server 不校验文件是否已在面板打开：未打开的工作区文件照常可读，没有面板的环境（见各查看技能）也依赖这一点。
- 生产技能、视觉评审 Agent 与许可证（Apache-2.0）保持不变；面板与 server 代码随 office-runtime 的 MIT 许可写入 `dist/LICENSE`。

## 2. 构建与产物

```text
apps/zcode-cli/packages/<name>-plugin/package.json  ── office.title / office.kinds
                │ pnpm --filter @zcode/<name>-plugin build
                ▼
office-runtime/scripts/build.mjs（插件名取自 .zcode-plugin/plugin.json）
                ▼
<name>-plugin/dist/
  server.mjs                 MCP server，esbuild 全量打包，运行时不读 node_modules
  ui/panel.html, assets.json 面板入口与分片脚本清单
  ui/bundle-*.txt …          面板脚本、pdf.js / xlsx 资源
  LICENSE, THIRD_PARTY_NOTICES.txt
```

- 插件名必须取自 manifest：它是 MCP 服务名、surface id 与 `ui://<name>/` 前缀，而内置包目录名带 `-plugin` 后缀。
- `dist/` 不入 git（`apps/zcode-cli/.gitignore`）。turbo 的插件 `build` 依赖 office-runtime 的 `build`（仅类型检查），office-runtime 源码变化会使四个插件的构建缓存失效。
- 查看器依赖（pdfjs-dist、docx-preview、pptx-renderer、react-xlsx、exceljs 等）声明为 office-runtime 的 devDependencies：它们只在构建期被打包，不作为运行时 npm 依赖分发；被打包部分的许可随产物写入 `dist/THIRD_PARTY_NOTICES.txt`。exceljs 的流式读写依赖（archiver、unzipper、tmp、fast-csv）在构建时以桩模块替换，不进入产物。

## 3. 必需资产与版本事实源

产物路径的唯一定义是 office-runtime `contract.ts` 的 `OFFICE_RUNTIME_OUTPUTS`：`dist/server.mjs`、`dist/ui/assets.json`、`dist/ui/panel.html`。以下清单都要同步：

| 位置                                                  | 内容                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bootstrap/src/app/official-plugin-definitions.ts`    | 版本 0.2.1（pdf 0.2.2，按插件各自声明）；`requiredSeedPaths` 增加 viewer skill 与 `OFFICIAL_OFFICE_VIEWER_RUNTIME_PATHS` |
| `cli/scripts/sea-official-plugin-assets.mjs`          | 版本 0.2.1（pdf 0.2.2）；`requiresRuntime: true`，`requiredRuntimePaths` 为面板产物                                      |
| `desktop/scripts/prepare-agent-node-bundle.mjs`       | `requiresRuntime: true`，`runtimeBuildScript` 指向 office-runtime 构建脚本                                               |
| `scripts/build-desktop-agent-cli.mjs`                 | dev 链路构建四个插件并校验 `dist/server.mjs`                                                                             |
| `server/src/remote/zcodeAgentOfficialPluginAssets.ts` | 远端必需资产加入 viewer skill 与面板产物                                                                                 |
| `docker/plugin-eval/Dockerfile`                       | 评测镜像在 stage 前构建四个插件                                                                                          |
| 各插件 `package.json` / `.zcode-plugin/plugin.json`   | 版本 0.2.1（pdf 0.2.2）；MCP server 声明 `"isolation": "workspace"`（§8）                                                |

`requiredSeedPaths` 缺项时 seed 只拒绝该插件并回退到可用旧缓存，不影响其他插件；因此未构建的开发环境会看到这四个插件停留在旧缓存或缺失，而不是全部插件失败。

桌面 bootstrap 构建路径原先对每个运行时插件先跑 `tsc` 再跑构建脚本；文档插件没有自己的 tsconfig，现改为仅在插件根目录存在 `tsconfig.json` 时运行 `tsc`。

## 4. 验收

- office-runtime：`typecheck`、`lint`、单测（解析器、锚点、文本、i18n、对齐、契约）。
- 四个插件：`build` 后 `smoke`（真实 stdio MCP：打开、读取、搜索、定位、越界路径拒绝）与 `test:e2e`（Chrome 中按 MCP Apps 沙箱 CSP 加载面板，覆盖选区引用、Agent 定位、查找、抽屉、截图、深色中文内联卡片）。
- 版本与资产一致性：bootstrap `plugins.test.ts`、`build-sea.test.mjs`、desktop `runtime-asset-scripts.test.ts`、server `remoteDeploy.test.ts`。
- 待补：在 ZCode 桌面端（含远程工作区）实际打开四种面板；e2e 不覆盖 Electron 沙箱本身。

## 5. 本地文件与窗口恢复（2026-10-16）

- 空状态为标题、描述、打开文件按钮与格式说明。按钮调用系统文件选择器，支持工作区外文件；取消不改变页面。
- 文件按 4 MiB 分块导入 `.zcode/document-imports/<uuid>/<filename>`，沿用 100 MiB 上限。预览与 Agent 引用副本，不修改原文件，不开放任意路径读取。同名文件独立保存。
- 手动新建文档窗口生成 instanceId，随标签页持久化。普通插件与工具驱动 surface 保持原路由。
- 完整 workspace/session/plugin/server/resource/surface instance 的 SHA-256 构成不透明 stateKey，面板 localStorage 保存该窗口最后成功加载的路径，不从服务器全局最后文档恢复。存储不可用时仍能预览，但不能保证恢复。

```mermaid
flowchart LR
  A[新建标签页] --> B[新 instanceId / 空状态]
  B --> C[选文件并成功加载]
  C --> D[按 stateKey 保存路径]
  E[回到原 session] --> F[恢复原标签页 instanceId]
  F --> D
  D --> G[加载该窗口上次的文件]
```

官方插件入口从内置原始 manifest 重建，保留真实入口及参数，修正错误缓存；HTTP/SSE 不按 stdio 校验。服务导出 main，直接执行时才自行启动。确认发送弹窗与选区提问浮层采用紧凑间距、输入区与统一边框，保留发送、取消及键盘行为。

### 场景与覆盖矩阵

| 场景                                       | 覆盖位置                                         | 边界                                               |
| ------------------------------------------ | ------------------------------------------------ | -------------------------------------------------- |
| 缓存入口修复、参数保留、HTTP 配置          | bootstrap/tests/official-plugin-runtime.test.ts  | 单元测试                                           |
| 分块顺序、未完成拒绝、同名隔离、取消清理   | office-runtime/src/adapters/files.test.ts        | 单元测试                                           |
| 新窗口隔离、序列化作用域稳定、session 隔离 | packages/ui/src/plugin-ui/contract.test.ts       | 单元测试                                           |
| 本地导入、重载恢复、新窗口空状态           | office-runtime/scripts/e2e.mjs 的 documents 分支 | 浏览器 AppBridge + 真实 MCP，不是 Electron E2E     |
| PDF/PPT 原生文件选择、PDF 同会话双窗口     | macOS 开发实例人工验收                           | 已验证；跨 session、远程工作区、Windows/Linux 待补 |
| 紧凑浮层与确认框                           | 原有交互回归与人工检查                           | 双主题、手机远控视觉验收待补                       |

## 6. PDF 中日韩文字

PDF 面板（`office-runtime/ui/viewers/PdfView.tsx`，pdf.js 5.4.296）对中日韩（CJK）文字的约定。随 pdf 插件 0.2.1 发布：升版让已装用户换到新的缓存目录，不沿用 0.2.0 的旧面板产物（其余三个文档插件仍为 0.2.0）。嵌入字体由 pdf.js 直接加载，不经下面的字体链；本节只处理**未嵌入字体**和**文字提取**。

### 6.1 未嵌入字体的字体链

pdf.js 对未嵌入字体只按字体名找同名系统字体，找不到就退回通用 `serif` / `sans-serif`，因此宋体常被画成黑体；字体名是 GBK 等多字节编码（如 `/#CB#CE#CC#E5` = 宋体）时 pdf.js 直接放弃替换。面板在 pdf.js 画布设置字体处接管字体链：

```text
PDF 字体（未嵌入）── 名称（含 GBK / Big5 / Shift-JIS / EUC-KR 解码）+ pdf.js 的 Serif 标志
        │ 分类 ui/cjkFonts.ts
        ▼
文种 sc | tc | jp | kr（默认 sc）× 字形 serif | sans | kai | fang（名称未识别时取 Serif 标志）
        ▼
canvas font = <pdf.js 原字体链（去掉末尾通用族）>, "zcode-cjk-<文种>-<字形>",
              ["zcode-cjk-<文种>-serif"（kai / fang 时）], ["zcode-cjk-fallback"], <通用族>
```

- `zcode-cjk-*` 是面板注册的 `FontFace`：来源为三端常见同类字体的 `local()` 列表（macOS 宋体-简 / 苹方 / 楷体-简…，Windows SimSun / Microsoft YaHei / KaiTi…，Linux Noto / Source Han / 文泉驿…），`unicode-range` 只覆盖 CJK 字符与全角标点，因此不改变拉丁文字的回退。
- 面板在文档打开前加载全部 `zcode-cjk-*`（`local()` 查找，无下载）。pdf.js 的原字体链放在最前：系统真的装有同名字体（如 Windows 的 SimSun）时仍用它。
- 只作用于 pdf.js 标记为缺字体文件的字体（`missingFile`），Type 3 与嵌入字体不变。
- 实现方式：构建时 esbuild 插件改写 pdf.js 画布 `setFont` 中计算字体链的一行（找不到原文即构建失败），调用 `ui/cjkFonts.ts` 的 `pdfTypeface`。

### 6.2 内置兜底字体

系统没有任何 CJK 字体（全部 `zcode-cjk-*` 都加载失败，常见于精简 Linux）时，面板在打开第一个 PDF 前加载随插件分发的 Noto Sans SC 400（Fontsource 5.3.1，OFL-1.1，按 unicode-range 切成 97 片、约 2.4 MiB、覆盖 GB2312 99.5%），注册为 `zcode-cjk-fallback`，排在字体链的通用族之前。画布绘制不等待字体，所以兜底字体必须在首次绘制前就绪，而不是绘制后补加载再重画。面板生命周期内只加载一次；有任一系统 CJK 字体的机器不会加载。字体文件以 `ui://pdf/assets/fonts/*.woff2` 资源读取，清单为 `ui://pdf/assets/cjk-fallback.json`；只有 pdf 插件的构建产出它们。

### 6.3 文字提取归一

Chrome / Skia 打印出的 PDF 常把部分汉字的 ToUnicode 写成部首兼容字符（文→⽂ U+2F42，黄→⻩ U+2EE9），画面正确但复制、查找、引用全错。server 解析（`read_document`、`search_document`）与面板文字层、查找统一经 `src/domain/cjk.ts` 的 `normalizeCjkCompat` 归一：康熙部首（U+2F00–2FD5）按 NFKC，部首补充（U+2E80–2EF3）按 Unicode 16.0 `EquivalentUnifiedIdeograph.txt`，只收等价字在 BMP 的 100 条（另 14 条是扩展区的部件字，不作替换）。不做整体 NFKC（会把全角标点变成半角）。替换前后都是一个 UTF-16 单元。

### 6.4 pdf.js 资源

面板资源白名单允许 `pdfjs/wasm/*.wasm`（openjpeg 解 JPEG 2000 图像、qcms 处理 ICC 颜色），此前被拒导致这两类内容无法解码。

### 6.5 验收

- 单测：字体分类与字体链（`ui/cjkFonts.test.ts`）、部首归一（`src/domain/cjk.test.ts`）、`fixtures/cjk.pdf` 的提取与搜索（`parse.test.ts`）、资源白名单（`src/adapters/assets.test.ts`）。
- pdf 插件 `test:e2e`：打开 `docs/cjk.pdf`，断言 `zcode-cjk-*` 字体在绘制前已加载、按归一后的引文定位与查找命中；另开一页让所有 `local()` 查找失败，断言只注册了 `zcode-cjk-fallback` 并截图留档；`smoke` 读取 wasm 与兜底字体资源。
- 待补：Windows / Linux 真机与无 CJK 字体环境的人工验证。

## 7. Review 收口：隐私、视图与导入生命周期

- 宿主仅下发完整作用域的 SHA-256 恢复键，不下发路径或 sessionId。窗口恢复与最近文件共用窗口级缓存，最多保留 128 个最近使用窗口；超出后最旧窗口回到空状态。
- report_view 携带 viewId，DocumentOwner 按窗口保存。get_view 可指定 viewId；多个窗口且未指定时返回窗口清单及歧义提示，不任选最后上报者。页面正常离开时释放视图；异常退出的旧视图最多造成保守的歧义提示，不串答。Agent 定位继续打开专用 surface，工具文案明确该行为。
- 导入由服务端串行管理；新导入准入前清理超过 10 分钟没有数据的未完成导入。服务端启动只清扫过期的 `.partial`，保留成品和近期其他进程导入。并发 begin 不突破每 session 4 槽的上限（§8.2），失败与退出清理不产生未处理 rejection。资源过期只用于回收，不用来决定页面同步顺序。
- 覆盖：恢复键隐私、窗口缓存上限与隔离、多视图歧义、并发上限、超时回收、启动清扫及完成副本保留。

## 8. 工作区共享 server

每个文档插件在同一工作区只起一个 MCP server 进程，供该工作区全部 session 共用（四个插件即每工作区四个进程）；此前每个 session 各起一份。面板、工具与交互不变。

### 8.1 宿主

- 插件 manifest 的 stdio / http MCP server 可声明 `"isolation": "workspace"`。插件 MCP 解析（`adapters/src/plugins/mcp.ts`）只对官方市场（`zcode-plugins-official`）插件透传该字段；其他插件的声明被忽略，保持 session isolation（`docs/mcp-platform-boundary.md`）。
- 连接池沿用 node_repl 的共享规则：键为 server 名 + workspaceKey + 解析后的配置（`adapters/src/mcp/pool.ts`），每个 session 持有一个 lease，最后一个 lease 释放后按既有 grace 关闭。`${ZCODE_PROJECT_DIR}` 不同的 session 配置不同，仍各起一份。
- 官方插件运行时 manifest 重写（`official-plugin-runtime.ts`）保留 `isolation`。
- 四个插件升版（0.2.1，pdf 0.2.2）：同版本缓存目录里的旧 `dist/server.mjs` 不区分 session，不能在新 manifest 下被共享。

### 8.2 server 状态按 session 划分

宿主给每次 `tools/call` 写入 `_meta.session_id`：Agent 调用来自执行工具的 session，面板调用（`mcp/uiCallTool`）来自面板所属 session（`adapters/src/mcp/index.ts` 的 `mcpRequestMeta`）。subagent 与工作流子代理的调用另带 `_meta.root_session_id`，即派生它的顶层 session（trace context 的 `rootSessionId`，在派生处写入、随子 trace 继承）。server 按 `root_session_id ?? session_id` 划分状态，所以 subagent 与父 session 的面板共用同一份查看状态，和改造前同进程时一致。session 只用来划分查看状态，不作授权依据：调用方只有宿主，面板不能自填 `_meta`。

```text
session 1 Agent ─ open_document(a) ──┐  _meta.session_id = s1
session 1 面板  ─ load / report_view ─┤
                                     ├──► 共享 server ── DocumentOwner
session 2 Agent ─ open_document(b) ──┤                    ├─ 解析缓存（共享，按路径 + size/mtime）
session 2 面板  ─ load / report_view ─┘  session_id = s2   ├─ s1：current、views、revealSeq、文件句柄
                                                          └─ s2：current、views、revealSeq、文件句柄
文件分块（resources/read）不带 session：按 load_document 发出的不可猜 token 查找
```

| 状态                                         | 归属                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 解析缓存                                     | 全 server 共享，上限 6 个文档                                                                            |
| `current`（get_viewer）、reveal 序号         | 每 session                                                                                               |
| 视图上报（report_view / get_view / release） | 每 session；get_view 只列本 session 的窗口                                                               |
| 文件句柄                                     | 每 session 最多 4 个，超出淘汰本 session 最旧的；面板读完最后一块即释放；token 全局唯一，分块按 token 查 |
| 导入                                         | 每 session 4 槽（§7 的上限与回收规则改为按 session 计）                                                  |

- 缺少 `session_id`（旧宿主、直接 stdio 启动的 smoke / e2e）时归入同一个默认 session，行为等同改造前的单 session 进程。
- server 收不到 session 关闭：session 状态按最近使用保留最多 32 个，超出时淘汰最久未用的 session 及其句柄；不用超时回收。被淘汰的 session 再次调用时从空状态开始，面板按 §5 的窗口恢复重新加载。
- 文件句柄只用于把字节交给面板：面板在 `load_document` 后立即按序读完全部分块并自留字节，server 送出最后一块即删除句柄。常驻字节因此只取决于进行中的加载，不取决于历史 session 数；面板读到一半消失时，句柄由本 session 的 4 个上限或 session 淘汰回收。
- `load_document` 解析期间所属 session 被淘汰时，不再登记句柄，返回 `invalid_token`，面板显示既有的重新加载入口。
- 导入槽位按 session 计：一个 session 放弃的导入不占其他 session 的槽位；10 分钟空闲回收不变。

### 8.3 行为变化

- server 崩溃影响该工作区所有 session 的同一面板；下次调用由连接池重连，面板显示既有错误态与重新加载入口。
- 进程生命周期随工作区内任一 session 的 lease 延续。

### 8.4 覆盖

| 场景                                                     | 覆盖位置                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方插件透传 isolation，非官方忽略                       | adapters/tests/plugin-mcp-isolation.test.ts                                                                                                             |
| session 间 current / 视图 / 句柄隔离、缓存共享、LRU 淘汰 | office-runtime/src/app/sessions.test.ts                                                                                                                 |
| 工具从 `_meta.session_id` 取 session                     | office-runtime/src/adapters/server.test.ts（内存传输）                                                                                                  |
| 两个 session 共用真实 stdio server                       | office-runtime/scripts/smoke.mjs                                                                                                                        |
| subagent 调用带 root_session_id，server 按它划分         | adapters/tests/mcp.test.ts；office-runtime/src/adapters/server.test.ts                                                                                  |
| 句柄读完最后一块即释放；淘汰中的加载不登记句柄           | office-runtime/src/app/sessions.test.ts                                                                                                                 |
| 导入槽位按 session 计                                    | office-runtime/src/adapters/files.test.ts                                                                                                               |
| 桌面多 session 真机                                      | macOS 开发实例人工验收通过（agent 日志中多个 session 的 `mcp.pool.lease.acquired` 指向同一 `mcpTransportPid`）；桌面 E2E、Windows/Linux、远程工作区待补 |

## 9. 文件树与文件链接入口（宿主代开文档）

桌面端从文件树、文件链接等入口打开 `.xlsx` 时，UI 直接打开 spreadsheets 面板并让它加载
目标文件，不经模型。产品边界（入口范围、`.xlsm` / `.xls` 保留 Preview Pane、回退语义）定义在
`docs/ui/office-file-preview.md` 的入口路由章节；本节只描述宿主与面板的接线。

- 路由表是 UI 层常量（扩展名 → `pluginId` + `surfaceId`），不是插件自声明的文件格式注册；
  出现第二个消费者时再升级为 manifest 声明，届时只替换数据源。
- 打开面板复用 `openPluginUiSidePane`：每个文件一个面板实例 tab
  （`instanceId = file:<相对路径>`），同一文件按确定的 tab id 去重，tab 标题显示文件名。各实例的位置与选区
  由 server 按 `viewId` 分开记录（§8.2）；会话级「当前文档」仍以最后一次 `open_document`
  为准，宿主不新建状态。
- 宿主驱动加载的通路，全部复用面板既有机制，office-runtime 零改动：

```text
UI 打开入口(.xlsx，能力门通过)
  │ openPluginUiSidePane(surface tab) + 记录待开路径
  ▼
订阅 pluginUiPageRegistry 等待该 surface 页面 phase=running（超时回退）
  ▼
Page.callPanelTool("open_document", { path })          ← 以面板实例身份经 mcp/uiCallTool
  │ 成功：structuredContent = ViewerSnapshot
  ▼
controller.notifyToolResult(result)                     ← 面板既有 toolresult 通知通道
  ▼
面板 office:toolresult → applySnapshot → load(path) → 分块读取渲染（§8.2）
```

- `Page.callPanelTool` 是 plugin-ui 宿主层新增的通用能力：以该面板沙箱实例的归属
  （workspace + session + plugin + server + instance）调用一次其 server 的工具，并把结果
  通过面板通知通道回投。open_document 本身 `visibility: ["model", "app"]`、`panel: true`，
  面板对结果的消费逻辑与 Agent 调用时完全一致。
- `open_document` 的 `path` 传 workspace 相对 posix 路径；server 端 `resolvePath` 的越界与
  类型校验（`unsupported_type` / `path_outside_workspace` / `not_found`）保持权威。
- 失败语义：面板就绪超时或 `open_document` 返回错误时，宿主回退打开 Preview Pane
  `code-viewer` tab 并 `logger.warn` 留痕；已打开的面板 tab 不强制关闭（面板保留自己的
  空态 / 错误态与重试入口）。`isError` 结果不投给面板，避免半开状态。
- 验收：桌面端真实打开（文件树点击与文件链接两条入口、多文件并存与同一文件去重、远程 / web 回退）；
  工程回归覆盖路由表匹配、能力门与超时回退的纯函数部分。
