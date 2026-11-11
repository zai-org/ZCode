# App 显式会话导航桥

SCT03 的桌面传输适配器实现 Host AppControlNavigationPort。项目授权、目标解析由 AppControlService 负责；本模块只关联请求、可信窗口、renderer generation、取消和回执，不持有会话事实或 accepted queue。

Host 经现有 parentPort 发送请求，Main 按显式 uiTarget 从当前 BrowserWindow 注册表解析唯一窗口；缺省使用可信 Host→window 绑定。不存在的显式目标不回落到当前窗口，回执 sender 由真实 IPC 连接绑定。Renderer 在原任务导航 hook 已挂载后登记能力，卸载、reload、窗口关闭或 Host 退出使在途请求失效。未登记 UI 立即返回 unavailable。手机不登记该 IPC 能力，不接收桌面导航。

```text
AppControlService → Host bridge → Main window bridge → platform → 原导航 owner
                         ↑             ↑                         ↓
                   scope / abort   generation guard ← 实际导航提交回执
```

发送事件不表示 opened。只有匹配请求及当前 generation 的真实导航回执可以返回 opened；Host 收口时复验可信连接。取消发送同一请求的撤销事件，renderer 必须在异步边界复验 signal。所有 pending 关联在完成或 teardown 后移除，无重试、持久缓存或业务超时推断。

## SCT07 只读来源解析

按 [App 控制规格 3.1](../../../../docs/architecture/zcode-app-control-design.md#31-跨项目只读发现修正2026-10-23)，Host 入口向 `createLocalServices.resolveAppControlDiscoverySource` 注入只读解析器。项目入口过滤和正文／写操作授权仍由服务层负责；本模块只解析已有在线来源并证明本次读取的连接代际。

- 优先读取 `windowRemoteConnectionRegistry.getOnlineSource`；无在线注册来源时，按已有 manager 状态匹配 hostId，再调用 `getOnlineConnection`。不初始化 manager、不连接、不启动 Agent、不调用身份绑定或 `resolveWorkspace`。
- 只允许当前 Server 显式声明 `virtualProjects: true`。注册来源即使存在兼容 `IProjectService`，也不能替代能力声明；不支持时抛出带 `code: source_unsupported` 的错误。离线、无项目代理或代际失效按来源不可用处理。
- `projects` 只暴露 `readTree` 合同，直接使用原始项目代理，保留项目、任务的源 hostId 和 workspaceIdentity。不得通过 `bindRemoteProjectIdentities` 改写身份。
- 注册 handle 在重连时可能不变，解析时捕获 handle、services 和 `physicalOwner()`；`assertCurrent` 复验三者及在线能力。manager fallback 捕获 `ManagedSourceServerConnection`，复验当前对象严格相等。调用者在异步读取后调用 `assertCurrent`，拒绝断线或换代的迟到结果。

```text
已有在线注册来源 ─ 优先 ─┐
已有 manager 在线连接 ──┴→ 捕获代际 → 原始 readTree → assertCurrent → 发现结果
                                                        └→ 断线／换代：拒绝
```

本解析器无缓存、持久状态、重试或导航事件；桌面和手机继续使用原会话工具结果通道。
