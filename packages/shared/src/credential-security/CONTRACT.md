# Credential security

后端共享的异步加密 adapter；Desktop、Host、CLI 与 Provisioning 使用同一格式。
公开面为 module.ts，系统库端口不进入前端或通用 RPC。默认随机密钥由系统凭据库保管；
Linux 必须使用持久 Secret Service。显式环境密钥用于受管无桌面环境。
旧版解码仅用于迁移/显式测试；默认写入 v2。库不可用与缺密钥不能归类为登录失效。
文件锁、整组更新和实际写盘仍由调用方的既有凭据容器负责。
同一进程、规范化凭据路径共用默认系统密钥加载结果，包括失败；失败后解锁并重启
再尝试，后台不自动重复触发系统授权。显式 KeyStore 注入按实例隔离。此缓存不缓存
凭据文件、账号资料或登录 Token，不跨进程传输主密钥，不更改系统授权策略。
桌面由 Main 独占系统库；Host 和内置 CLI 通过已建立的私有通道委托单次加解密。
请求不接受目录参数，绑定目录由 Main 决定；通道关闭拒绝等待项并忽略迟到响应。
只返回受控错误分类，消息载荷不记录日志。Standalone CLI/独立服务器保留本机 owner。
规格：docs/plans/2026-10-29-system-credential-storage.md。

Server 在开放服务前调用系统 cipher 的 initialize。无桌面可显式挂载
ZCODE_CREDENTIAL_SECRET_FILE（32–4096 字节、原字节、不与直接环境密钥并用），
只传文件位置，不把文件内容写入环境或日志。缺失/不可读的后端阻止 Server 就绪。
v1 解码同时兼容 Desktop 原字符串、CLI trim 和历史默认派生规则；v2 保留原始密钥语义。
桥协议按明文 UTF-8 字节、密文膨胀分别限流；每个可关联的回复成功或拒绝一次，
非法回复和过大输出不得留下等待项或持有凭据文件锁。

createServerCredentialCipher 仅用于 Server 启动：显式配置优先，否则识别凭据目录里
已创建的私有 credential-secret 文件。无后端时错误包含
远端配置位置与重连指引。Desktop Main 继续使用 createSystemCredentialCipher。

prepareServerCredentialStorage 仅由 Desktop 的远程启动命令显式调用，返回 void，不传出
密钥。显式配置、已有约定文件或 v2 数据都不改写；否则按凭据锁 → 密钥锁的顺序，
原子排他发布该数据根的 0600 随机密钥文件。失败向上传播，不继续发布 ready。
独立 Server 未传准备参数时仍遵循原显式配置 / 系统库规则。

同一凭据目录的默认来源解析由 createSystemCredentialCipher 唯一负责，Server 与独立 CLI
均发现私有 credential-secret。系统库成功初始化时，在同一 keyring 锁内原子写入
credential-source（内容仅为 os，不含密钥），将来源固定到 OS；准备流程见到该标记后
不能另建文件密钥。已有 v2:os 记录也固定到 OS，来源/密钥失效不改用其他来源。
显式环境配置仍优先；来源选择与系统密钥加载共享同一个进程内 Promise。

createLegacyServerCredentialCipher 仅用于旧 Supervisor 托管的更新候选 Core：已有 v2
则拒绝启动，只有 v1 时沿用旧加密/解密且不迁移。正常 Server 和独立 CLI 不选择此模式。
此兼容路径复用受管密钥解析，接受显式值、显式文件及私有约定文件。写入继续使用能
认证已有 v1 的历史密钥；新准备的随机文件不能抢先替换旧 fallback/trim 密钥。

enablePrivateFileKeyFallback 仅由 Linux Desktop Main 在首次访问凭据前调用，返回是否生效；
已有密钥加载结果时不生效。开启后，keyring 锁内访问系统库失败且目录未绑定来源
（无 credential-source、无 v2 密文、无私有文件）时，排他发布 0600 credential-secret 并
使用它；已绑定来源绝不切换。独立 CLI、Server 不开启。规格见上述 spec 的
“Linux Desktop 私有文件密钥回退”。
