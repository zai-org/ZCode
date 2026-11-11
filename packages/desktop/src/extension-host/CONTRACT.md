# 扩展进程

设计见 `docs/plugins/extension-host.md` §12。本模块是全 App 唯一的扩展进程，以及 Main 侧的监管器 `main/extensionHostSupervisor.ts`。

- 扩展进程只经 parentPort 与 Main 交换生命周期消息（初始化、牵线、探测、日志、计划重启、dispose）；业务数据只走 Main 牵线给 Window Host 的 L1 端口。不连 CLI，不连 Renderer。
- 本进程不读 `plugin.json`：静态声明（清单状态、插槽条目、命令、视图）归 Window Host（§16.1）。Window Host 经 `setDeclarations` 只给合法、兼容的扩展声明；本进程对比声明后激活、停用，已激活扩展的声明变了就请求计划重启。
- 贡献表的唯一 owner 是本进程的注册表，只含运行状态（`resolved`、`activating`、`active`、`failed`）与插槽动态值。状态变化推整份快照，`slots.update` 推增量，两者共用 `rev`。动态值只在内存里，进程重启后清空。
- 激活是事务：`activate` 期间的注册先缓存，成功后一起生效；抛错或超过 10 秒全部丢弃，扩展进入 `failed`，本进程内不再激活。
- `ctx` 冻结；停用后调用抛 `disposed`。扩展代码的未捕获错误只记日志并归因插件；`process.exit` 抛错。
- 监管器：每次启动 gen + 1；5 分钟内崩溃 3 次后停止，退避 1s、2s；存活探测 5 秒一次，连续 3 次没有回应判为卡死并计入预算；计划重启与重新加载不计入预算，重新加载清零预算，已停止时也能用。
- 环境变量只传白名单（`EXTENSION_HOST_ENV_ALLOWLIST`，只在监管器定义一次）。设置页的代理、No Proxy 与自定义证书（§12.1、§18.1 H3）经依赖 `readNetworkSettings` 在每次启动前读一次，按 CLI 的同一翻译写入（两种大小写都写）。代理、No Proxy 与证书不在白名单里，只认设置页，留空就直连（与 CLI 一致，用户决策）；日志只记每项是否由设置页配置。扩展进程在加载扩展前调一次 `http.setGlobalProxyFromEnv()`（`enableEnvironmentProxy`），全局 fetch 走环境代理；证书由 Node 启动时读 `NODE_EXTRA_CA_CERTS`。改设置后「重新加载扩展」生效。
- 日志（§16.8）：监管器写日志文件的每一行（扩展的 `ctx.log`、扩展进程自己的日志与 stdout/stderr、监管器的生命周期行）同时进它的环形缓冲（最近 2000 条，message ≤ 4KB，seq 连续递增），扩展进程崩溃、重启后保留。追加的条目按事件循环成批（`setImmediate`）推给已就绪的 Window Host；收到 `logs-request` 当场回 `logs-snapshot`。parentPort 发送失败只写日志文件，不进缓冲。
- `ctx` 的能力部分由能力表经通用包装（call / subscribe、重连后重新订阅）生成；带入参的订阅是 `(input, listener)`，没有入参的是 `(listener)`，入参按能力表校验并参与订阅去重的键（§17.3）。`ctx.views.open` 是能力 `views.open` 的本地包装，先校验视图 id。档位与授权由 Window Host 的网关判断，本进程不判断。
- 扩展视图（`viewHost.ts`、`viewServer.ts`）：写法一由宿主用低层 MCP `Server` 包装 `ViewDefinition`（entry 每次打开时从插件根目录读取，路径按字面与真实路径都不能跳出根目录；`onDidOpen` 在实例打开时调用，抛错则本次打开失败）；写法二由插件工厂返回自己的 server。两者都经 `InMemoryTransport` 连一个 MCP `Client`。订阅在请求层记账，`view.notify(uri)` 只发给订阅了 uri 的实例。扩展停用、Window Host 断开时关闭对应实例。MCP SDK 内联进本进程产物。
