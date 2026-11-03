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

页面请求 → browser session 协议 handler → 验签/真实路径边界 → 只读资源
```

main 是进程内签名密钥和导航准入的唯一 owner。旧异步结果不得覆盖新导航。
renderer 继续沿用现有 pendingUrl 和 guest 接管回执，不增加导航队列。
初始/恢复入口传入的 file URL 同样经过转换；页面自己触发的原始 file 请求不会获得授权。

## 验收

候选 E2E：`packages/desktop/test/e2e/manual-review/pending/browser-local-html-preview.test.ts`。
既有回归：`packages/desktop/test/e2e/browser-open-external-file-url.test.ts`。

| 场景                | 必须断言                                                        | 证据         |
| ------------------- | --------------------------------------------------------------- | ------------ |
| 中文/空格 HTML 路径 | 页面实际 URL 为预览协议，地址栏显示解析后的 file 路径           | 桌面安全 E2E |
| 相对资源            | CSS、图片、普通脚本、ES Module、JSON fetch 成功                 | 桌面安全 E2E |
| 越界读取            | file fetch/iframe、路径穿越、符号链接、隐藏文件、伪造签名均失败 | 桌面安全 E2E |
| 刷新/历史           | 页面重新加载，相对资源仍可用，后退回到原预览地址                | 桌面安全 E2E |
| 隔离                | 默认 session 的 file 页面及普通 HTTP 页面仍可加载               | 桌面安全 E2E |
| 外部打开            | 预览页还原为 file URL，仍走 shell.openPath                      | 外部打开 E2E |
| 导航竞态            | 先发起的文件检查不得覆盖后发起的导航                            | 桌面安全 E2E |

### 验证记录（2026-10-28）

- macOS / Electron 44.7.0 的完整应用验收通过；产物见下方运行目录。
- Windows/Linux 尚未运行；使用 Node 原生路径解析和 realpath，不将 macOS 结果外推。
- Web/手机不承载 Electron webview，也不注入此本机平台能力；本次未改动其界面和远控协议。
- 独立 Electron 场景另外验证了默认 session 的 module/fetch 未受影响、模拟目录外内容未到达 loopback 收集端，以及不同 controller 的签名不能互用。
- 新用例保持 manual-review/pending；未做人工转正或 CI 准入。

完整桌面安全及外部打开 E2E：`packages/desktop/.e2e-artifacts/desktop-e2e-20261028143115506-p90003-1da21085337a8236`，2 个 spec 均通过。

可重复运行安全用例（仅使用本地 fixture，不调用模型）：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 E2E_PROVIDER_HTTP_MODE=replay \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/manual-review/pending/browser-local-html-preview.test.ts'
```
