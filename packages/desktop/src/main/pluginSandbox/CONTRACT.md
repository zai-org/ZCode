# plugin-sandbox

Electron Main 适配层，拥有沙箱内容、guest、端口和浏览器分区。Host 登记适配器仅转发请求，不拥有任务事实。

- 登记绑定实际 Host attachment 的 ownerWebContentsId、workspace、session、server、scope 和 Agent 运行凭证；同凭证重复登记返回不可变句柄，不覆写 HTML。sandboxId/initId 仅服务单次 Electron 生命周期。
- partition 为 `persist:plugin-sandbox-v2-<hash(appIdentity)>`。shell/plugin 两个不同 origin 都由可信 appIdentity 派生；随机 sandboxId 位于资源路径。Chromium 的顶层站点存储键必须稳定，才能使 localStorage/IndexedDB 跨进程恢复。
- 稳定 origin 不授予资源权限。protocol 校验 origin、实例路径和登记；session 请求检查实际 guest 与目标实例；will-attach-webview 验证 owner、partition 和句柄。重载、销毁与越界导航撤销旧登记；重载指 shell 主 frame 或其直接子 frame（插件 frame）的跨文档导航，插件文档内部的子 frame（如 srcdoc 预览）导航不撤销登记，仍受插件 CSP（`frame-src` 缺省 none）与导航 origin 白名单约束。
- guest 固定 contextIsolation/sandbox/webSecurity，禁用 Node、子框架 Node、webviewTag、plugins、dialogs/popups。MessagePort 在受信 guest 就绪后分发，shell 只转发 JSON-RPC；旧端口不能替代新实例。
- CSP 使用 default-src none；资源域、连接域、frame 域按声明派生。frame-ancestors 只允许该稳定 shell origin；form-action none。既有 zcode/csp 扩展只放宽 unsafe-eval/wasm-unsafe-eval，不增加浏览器能力。
- 原生 camera/microphone/geolocation/clipboardWrite 仍按资源声明和既有确认策略授权；绑定实际 guest/frame、owner、运行凭证，异步确认和系统授权返回后再验证。失效页面的确认不能授权替换页面。
- guest 输入产生 5 秒一次性手势 token。关闭实例同时释放 ports 和实际 guest，partition 持久保留。
- 上限 64；Main 不抢占其他窗口或刚准备的实例，只清过期且未被 guest pin 的登记。Renderer owner 决定业务回收；容量不足明确报错。
- `setExecutionActive` 仅接受宿主 sender 对当前 sandboxId/initId 的 MCP 请求，Gen UI 不接入。复用目标 guest 的可逆 capturer 活动，不改变全窗口后台节流；登记撤销、guest/owner 销毁释放活动。Renderer page owner 按保留页面的可见性请求活动，不根据 session 执行状态停止页面；Main 不保存第二份业务状态。
- 撤销登记先关端口，再由 Main 单次导航 guest 到 about:blank，等待旧插件 frame 移除后 close；IPC dispose 等待同一个停止 Promise。Electron 附着 webview 的 destroyed 可能仅释放包装对象，不是停止页面写入的屏障；插件 beforeunload 不能阻止宿主释放。
- 清除所有数据先阻止新登记、撤销登记并等待所有 guest 停止（含已在 dispose 的实例），再 clearStorageData/clearCache，覆盖所有新旧 MCP App 分区。停止失败不能继续报告清理成功；flushStorageData 不是完成屏障。平时保留旧 v1 分区，不迁移或自动合并；本模块不访问插件 SQLite 或业务文件。

公开入口 `index.ts` 不暴露 registry/preload/assets。Main 不执行 MCP 权限策略，不保存会话、队列、widgetState；受信 Host 提供已验证 HTML 与实例绑定。

## 实例资源缓存边界

稳定 origin 下所有实例协议响应（包括 shell、alias 与静态脚本）必须使用 `Cache-Control: no-store`。页面存储仍持久化，但响应缓存不得绕过实际 guest 与实例路径校验；真实 Electron 验证必须同时包含冷请求和缓存命中候选。

## Gen UI 随包资源

Gen UI 的 CSS/inner kit 使用 Visualize 插件的同一份固定资源，构建复制到沙箱资源目录，Main 在返回文档时注入；不再在 guest 里执行另一套 Widgets。bridge/Tweak 先于作者片段，inner kit 后于片段。Floating UI、Lucide、D3 的固定 CDN script URL 在 Gen UI partition 请求闸门内映射到同一实例的随包文件，按 `vendor/manifest.json` 精确匹配，不扩大 CSP 或开放任意文件。缺失文件失败，不回退网络；保留现有脚本加载顺序，D3 仍按需。Tweak 的私有回调经现有 Gen UI 方法，不向页面开放 callTool。MCP 文档不加载或重定向这些资源。

资源完整性由 Visualize 的 `assets/runtime-manifest.json` 维护，结构仅为 `files → 文件名 → sha256`，记录当前 CSS、inner kit、calendar 和 Tweak 文件的 SHA-256。桌面资源测试核对实际复制字节与清单；Tweak 注释变更也需要同步哈希。资源名称变更须同时更新 Desktop、CLI SEA、远程预构建、服务端远程部署与插件 seed 校验入口；缺少清单或必需文件仍按现有规则失败，不回退到旧名称。插件的许可入口统一为 `skills/visualize/LICENSE.md`，保留许可限制与第三方依赖声明。

离线依赖继续由 `assets/vendor/manifest.json` 记录固定 npm 版本、包完整性、脚本及许可文件哈希。更新时核对包完整性、提取声明的分发文件和许可证，再更新哈希；Desktop 与独立导出共用这些文件，导出脚本将其嵌入为 data URL。验收覆盖复制资源的哈希、各打包清单路径存在性与许可入口可解析性；交互和会话状态契约不变。

Host preload enables state-preserving atomic moves only for explicitly marked sandbox webviews. The hook is installed before Electron registers its custom element; ordinary detach/disposal and unmarked webviews retain their original behavior. Main copy-image IPC validates sender owner, sandboxId/initId and bounded content/viewport geometry before and after native capture, crops using the actual image scale, and writes the native clipboard. It exposes neither arbitrary guest IDs nor image bytes to untrusted page code.

Electron 44 图片复制以 PNG Blob / ClipboardItem 调用异步 clipboard.write。IPC 等待实际写入完成后才报告成功；原生写入错误仍向调用方传播。截图期间失效的实例不能继续写入，原有 owner/initId 与 guest 校验不变。

`contentKind: "extension"`（扩展视图）由 Window Host 签发凭证，appIdentity 按插件派生（同一插件的视图共享持久分区，不同插件隔离），没有会话：注册表只要求 pluginId，拒绝 sessionId、serverName 与原生权限声明。页面与 MCP App 一样注入 alias 兼容层。

`contentKind: "gen-ui"` 由桌面 Host 签发独立凭证，不要求 pluginId/serverName，也不能携带原生权限。使用内存分区 `gen-ui-<appIdentity>`；跨重开恢复依赖 Gen UI 服务，不依赖浏览器存储。HTML 外壳包含先于作者脚本执行的已转义状态快照与专用 `gen-ui.js`，不注入旧兼容桥。连接、子框架和表单提交禁用，静态资源限制为 Gen UI 固定域。其余 owner、guest、端口、手势和撤销机制复用本契约。
