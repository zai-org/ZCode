# Web 浏览器支持范围

`packages/web` 产物（远控 `/remote`、分享页、Web 登录）运行在用户自己的浏览器里，版本不受我们控制。桌面 Electron 自带新版 Chromium，不在本文范围内。

## 最低版本

| 层            | 最低版本                                      | 来源                                                                         |
| ------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| JS 语法       | Chrome/Edge 111、Firefox 114、Safari/iOS 16.4 | Vite 8 默认 `build.target: "baseline-widely-available"`                      |
| CSS           | Chrome/Edge 111、Safari 16.4                  | `packages/ui/src/styles.css` 的主题 token 直接使用 `color-mix()`，没有回退色 |
| JS 运行时 API | 同上；下表中的 API 由 polyfill 补齐           | `packages/web/src/main.tsx` 开头的 core-js 导入；pdf.js 见下文               |

正式支持范围是 Chrome/Edge 111+。低于 111 的浏览器不承诺可用：polyfill 只保证常用页面不因缺少 API 而崩溃，边框、部分背景色可能缺失，PDF 预览没有在这些版本上验证。

## Polyfill 规则

Vite 只转换语法，不补运行时 API。代码或依赖使用的 API 若高于上面的语法基线，必须在 `packages/web/src/main.tsx` 开头按需引入 core-js 的单项模块（`core-js/stable/<namespace>/<method>`），不引入整包。

| API                          | 原生起始版本（Chrome） | 使用方                             |
| ---------------------------- | ---------------------- | ---------------------------------- |
| `Array.prototype.toSorted`   | 110                    | `packages/ui`、`packages/web` 多处 |
| `Array.prototype.toReversed` | 110                    | `packages/ui`                      |
| `Object.groupBy`             | 117                    | 第三方依赖 chunk                   |

- polyfill 导入必须放在 `packages/web/src/main.tsx` 所有其他 import 之前。ES module 按 import 顺序执行，这样其他模块求值前 API 已就绪。
- core-js 先检测原生实现，新版浏览器上不覆盖原生方法。
- 只在 `packages/web` 引入；`packages/ui` 不负责补环境，桌面端不加载这些模块。
- 新增上表以外、且高于语法基线的 API 时，同步更新本表和 `main.tsx` 开头的导入。pdf.js 用到的 API 不列入本表，见下一节。
- `AbortSignal.any`（Chrome 116）不补 polyfill，`packages/web` 不直接调用。合并调用方取消与请求期限时，用 `AbortController` 加 `setTimeout`，期限覆盖到正文读取完成；远控请求复用 `withWebRemoteControlHttpSignal`，Web 登录在 `webRegionalOAuth.ts` 内用同样写法。`AbortSignal.timeout`（Chrome 103）在基线内，可直接使用。

## PDF 预览（pdf.js）

pdf.js 在两个独立的全局作用域里运行：页面主线程，以及 `packages/ui/src/components/ui/pdf-viewer.tsx` 通过 `workerSrc` 单独加载的 Worker。`main.tsx` 的 polyfill 只修改主线程全局，不进入 Worker。

`pdfjs-dist` 的默认构建在两侧都直接调用 `URL.parse`（Chrome 126）和 `Promise.withResolvers`（Chrome 119）。主线程的 `getUrlProp()` 在创建 Worker 之前就调用 `URL.parse`，所以字符串 URL（blob/http/https）在 Chrome/Edge 111–125 上直接抛 `TypeError`，会话区域崩溃。即使主线程补了 `Promise.withResolvers`，Uint8Array 与 range 数据源也只是在 Worker 启动失败后退化成主线程 fake worker 才能显示；只在主线程再补 `URL.parse` 会启用真实 Worker，range 数据源又会因 Worker 缺 `Promise.withResolvers` 失败。

因此 Web 构建改用 pdf.js 官方的 legacy 构建：

- `packages/web/vite.config.ts` 用两条精确匹配的 alias，把 `pdfjs-dist` 主入口和 `pdfjs-dist/build/pdf.worker.min.mjs` 换成 `pdfjs-dist/legacy/build/` 下的同版本文件。legacy 构建的主线程文件和 Worker 文件各自带 core-js polyfill，两个全局作用域都能覆盖。
- alias 必须用正则精确匹配。字符串键 `"pdfjs-dist"` 按前缀匹配，会把 Worker 路径也改写成错误路径。
- 主线程和 Worker 必须来自同一个 `pdfjs-dist` 版本，否则 Worker 的版本校验会拒绝文档。
- 只在 `packages/web` 切换。桌面端 Electron 使用默认构建，`packages/ui` 源码不变。dev server 与生产构建使用同一份 alias；dev 下同时用 `optimizeDeps.exclude` 排除 `pdfjs-dist`，否则依赖扫描会把带 `?url` 的 Worker 导入当成依赖预构建并失败。
- pdf.js 的 API 由 legacy 构建自带，`main.tsx` 不再为 pdf.js 引入 polyfill。
- 升级 `pdfjs-dist` 时，用下面的回归场景在低版本浏览器上复测。

## 回归场景

- ZCT-2118215639243444224：Chrome 109 打开远控会话，某一轮含 Hook 执行记录时，`ConversationHookDetailsAction` 调用 `executions.toSorted` 抛 `TypeError`，区域错误边界显示“这块界面出了点问题”。加 polyfill 后该会话正常渲染。E2E：`packages/desktop/test/e2e/conversation-session/hooks/manual-review/pending/conversation-session-hooks-mobile.test.ts`（HK-MOB-01，pending），默认用新版 Chrome；设置 `ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE` 可指定低版本浏览器。
- Chrome/Edge 111–125 打开以字符串 URL 为数据源的 PDF 预览（例如手机输入框中粘贴的 PDF 附件，数据源是 blob URL），pdf.js 抛 `TypeError: URL.parse is not a function`。react-pdf 在 effect 中同步抛出该错误，整个会话区域被错误边界替换为“这块界面出了点问题”。改用 legacy 构建后，PDF 正常渲染，且使用真实 Worker。E2E：`packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-pdf-preview-mobile.test.ts`（PDF-MOB-01，pending），浏览器选择方式与 HK-MOB-01 相同。
- 3.18.0 发布验收 Case 69：Chrome 113 点击「通过浏览器授权登录」后立即提示授权未完成。`webRegionalOAuth.ts` 在 `/api/v1/oauth/cli/init` 请求前调用 `AbortSignal.any`，抛 `TypeError`，授权弹窗随即关闭。改用 `AbortController` 合并取消与 15 秒期限后，初始化、轮询、取消和超时在 Chrome 113 上按原语义工作。
- 构建后在产物中能找到上表各项的 polyfill，且 core-js 代码位于入口 chunk 的业务代码之前；PDF chunk 与 `pdf.worker.min-*.mjs` 来自 `pdfjs-dist/legacy/build/`。
