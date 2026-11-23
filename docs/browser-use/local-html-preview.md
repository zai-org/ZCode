# 内置浏览器本地 HTML 预览

## 边界

内置浏览器打开本机 `file://` 的 `.html` / `.htm` 时，由 main 转成
`zcode-html://` 地址。卡片、文件树、地址栏仍使用现有打开入口。
仅 `persist:zcode-embedded-browser` 安装协议 handler；defaultSession 沿用现有加载逻辑，
Web 和手机端不注入本机预览能力。HTTP/HTTPS 的导航语义不变。

修复原因：Electron 默认赋予 file 页面额外的跨文件读取权限，sandbox 和
contextIsolation 不会阻止这些读取。初次 attach 的 URL 校验也不覆盖之后的 loadURL。

## 授权与资源

- 只有可信宿主窗口的主 frame 可以请求 main 导航自己承载的 browser guest。
- 显式打开 HTML 授权其真实所在目录及子目录；不自动扩大到项目目录或父目录。
  不允许磁盘根目录、网络共享、隐藏文件/目录或非 HTML 作为授权入口。
- 每次资源请求都检查 URL、请求方法、目录签名、真实路径及普通文件类型。
  拒绝父目录穿越、编码分隔符、指向目录外的符号链接、隐藏文件和目录列表。
- 真实路径只证明“名字”在预览根内，不证明“内容”在预览根内：子树内的硬链接 realpath 仍是自身，
  却与子树外文件共享同一 inode（ZP-20261105-09）。因此资源读取以文件句柄为准：
  1. `open` 绑定文件；之后的读取只使用该句柄，不再按路径二次打开，检查与读取之间没有替换窗口；
  2. `realpath` 必须仍在预览根内，且 `stat` 该真实路径得到的 (dev, ino) 与句柄 `fstat` 相同。
     POSIX 为 st_dev / st_ino；Windows 由 Node（libuv）取得卷序列号与文件索引，同样比较 (dev, ino)；
  3. 句柄必须是普通文件，`st_nlink`（Windows 为 nNumberOfLinks）为 1，且 ino 非 0。
     多链接文件或拿不到文件索引时返回 403，并记录一条不含文件内容的警告。
     多链接一律拒绝，是因为硬链接的各个名字地位相同：realpath 只返回请求所用的名字，
     要知道其他名字在哪里只能扫描整卷；句柄层也分不清“目录内指向目录外的硬链接”与“目录内的正常硬链接”，
     因此两者一并拒绝，不做“只拒绝目标在预览根外”的判断，也不做按 node_modules 等目录放行的例外。
- 已知误拒：预览根内直接引用 pnpm 硬链接文件（通常位于 `node_modules`）的页面，资源返回 403。
  这是接受的代价，理由同上。据 pnpm 默认配置推断，macOS APFS 上通常使用 clone，nlink 为 1，
  主要影响 Linux 与 Windows；该推断未在各平台实测。打包后的 `dist/` 不含硬链接。
- 纵深防御（copy-on-serve、目录监听告警、预览页网络隔离、禁止受限环境建硬链接）本次未实现，
  仅作为后续建议。
- 响应类型由模块内的扩展名表决定，因为句柄读取不再经过 Chromium 的 file loader。
  表的内容按修复前 `net.fetch(file://)` 在 Electron 44 / macOS 上按扩展名返回的类型补齐；
  表外扩展名返回 `application/octet-stream`，并带 `nosniff`。修复前这类文件靠内容嗅探决定类型，
  现在不再嗅探，因此表外的文本文件可能变为下载、表外的脚本无法加载。新增常用类型时补进表里。
- Range 请求不处理，一律返回 200 与完整内容。这与修复前一致：原实现的 `net.fetch` 只转发 method，
  不转发请求头。小型音视频在完整响应后仍可拖动；大文件拖动需另行实现 Range，并为协议声明 `stream`。
- HTML 的相对 CSS、普通脚本、ES Module、图片及 fetch 数据使用相同预览 origin。
  不设置通配 CORS，不绕过 CSP，不启用 service worker。根绝对资源路径需改为相对路径。
- 内置浏览器 session 的原始 file 请求全部拒绝，包括导航、iframe 和 fetch。
  非 HTML 的独立 file 导航显示原有加载错误；它们不被自动授权。
- 每个目录使用不同的签名 hostname，页面不能修改地址来授权其他目录。
  签名密钥仅保存在 main 当前进程中，网页和 preload 均不获得密钥。
  刷新和进程内 guest 恢复复用该地址；完整退出清空标签，旧签名在下次启动失效。
- 地址栏展示及“默认浏览器打开”转换回解析后的本地 file URL；该转换仅作展示，不能授权文件。

## 所有权与时序

```text
宿主 renderer 的现有导航入口
  → main 校验 sender、guest 所属窗口和 browser partition
  → 分配 guest 导航序号 → 异步校验 HTML/生成签名 URL
  → 仍为最新导航且 guest 存活 → loadURL
  → Chromium 提交 URL → 既有进程内历史/恢复机制保存

页面请求 → browser session 协议 handler → 验签
  → open 绑定句柄 → realpath 在预览根内 → stat(真实路径) 与 fstat(句柄) 同一 (dev, ino)
  → fstat 句柄：普通文件且 nlink = 1 → 从同一句柄流式返回只读资源
  （任一步失败：关闭句柄，返回 403；句柄未通过前不读取内容）
```

main 是进程内签名密钥和导航准入的唯一 owner。旧异步结果不得覆盖新导航。
renderer 继续沿用现有 pendingUrl 和 guest 接管回执，不增加导航队列。
初始/恢复入口传入的 file URL 同样经过转换；页面自己触发的原始 file 请求不会获得授权。

## 验收

正式 E2E：`packages/desktop/test/e2e/browser/files/browser-local-html-preview.test.ts`。
既有回归：`packages/desktop/test/e2e/browser/files/browser-open-external-file-url.test.ts`。

| 场景                | 必须断言                                                        | 证据         |
| ------------------- | --------------------------------------------------------------- | ------------ |
| 中文/空格 HTML 路径 | 页面实际 URL 为预览协议，地址栏显示解析后的 file 路径           | 桌面安全 E2E |
| 相对资源            | CSS、图片、普通脚本、ES Module、JSON fetch 成功                 | 桌面安全 E2E |
| 越界读取            | file fetch/iframe、路径穿越、符号链接、隐藏文件、伪造签名均失败 | 桌面安全 E2E |
| 硬链接别名          | 预览目录内指向子树外文件的硬链接 fetch 失败（nlink > 1 拒绝）   | 桌面安全 E2E |
| 句柄边界            | HEAD 只返回头与长度；目录、FIFO 被拒绝且不挂起；`.md` 类型正确  | 桌面安全 E2E |
| 刷新/历史           | 页面重新加载，相对资源仍可用，后退回到原预览地址                | 桌面安全 E2E |
| 隔离                | 默认 session 的 file 页面及普通 HTTP 页面仍可加载               | 桌面安全 E2E |
| 外部打开            | 预览页还原为 file URL，仍走 shell.openPath                      | 外部打开 E2E |
| 导航竞态            | 先发起的文件检查不得覆盖后发起的导航                            | 桌面安全 E2E |

### 验证记录（2026-10-28）

- macOS / Electron 44.7.0 的完整应用验收通过；产物见下方运行目录。
- Windows/Linux 尚未运行；使用 Node 原生路径解析和 realpath，不将 macOS 结果外推。
- Web/手机不承载 Electron webview，也不注入此本机平台能力；本次未改动其界面和远控协议。
- 独立 Electron 场景另外验证了默认 session 的 module/fetch 未受影响、模拟目录外内容未到达 loopback 收集端，以及不同 controller 的签名不能互用。
- 2026-11-10 已人工复核并转正，独立及默认回放均通过；证据见[转正清单](../testing/e2e-business-scenarios.md#2026-11-10-人工复核与转正回放)。未新增 Docker/三平台 CI 准入。

完整桌面安全及外部打开 E2E：`packages/desktop/.e2e-artifacts/desktop-e2e-20261028143115506-p90003-1da21085337a8236`，2 个 spec 均通过。

可重复运行安全用例（仅使用本地 fixture，不调用模型）：

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/browser/files/browser-local-html-preview.test.ts'
```

### 验证记录（2026-11-16，ZP-20261105-09 硬链接绕过修复）

- macOS / Electron 44.7.0：`browser-local-html-preview.test.ts` 通过（含新增的硬链接别名断言）；
  `browser-design-mode`、`browser-design-page-tools`、`browser-open-external-file-url` 组合运行通过。
  组合运行的一次中，`browser-design-page-tools` 的 BU-E2E-023 超时失败；单独运行与再次组合运行均通过，
  尚未定位为本次改动所致，记为偶发待观察。
- 运行时对照（临时脚本，未入库）：修复前，预览目录内指向子树外文件的硬链接返回 200 并读到外部内容；
  修复后返回 403 并记录 `nlink=2` 警告。符号链接、FIFO（不阻塞）、缺失文件、HEAD 行为保持不变。
- Windows/Linux 未运行。Windows 的 dev/ino/nlink 语义依据 libuv 的 NT 实现推断，未在 Windows 实机验证。

### 验证记录（2026-11-17，staging 基线，多链接决策）

- 分支已 rebase 到 `origin/staging`（`8ef505a287`）；`browser-local-html-preview.test.ts` 在该基线上通过（macOS / Electron）。
- 多链接文件保持 403（决策见上文「多链接一律拒绝」），不放行 `node_modules` 或目标不敏感的文件。
- 运行前需先执行 `pnpm build:cua`，否则 `node-repl-host` 的构建因缺少 `@zcode/zcode-cua` 产物而失败（与本改动无关）。
