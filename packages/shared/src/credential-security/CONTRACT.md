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

prepareServerCredentialFile 是 Server 准备命令的入口，返回 Server 应使用的凭据文件。
共享库（与同机 Desktop 共用）已固定为 OS 来源时，创建 Server 自有目录并在其中准备密钥；
显式密钥已配置且共享库已有 enc:v2:env: 时保持共享库；其余沿用
prepareServerCredentialStorage 的共享库规则。判定在共享库的凭据锁 → 密钥锁内完成。
自有目录与其中的 credential-secret 经临时目录 rename 原子发布，目录存在即密钥就绪。
resolveServerCredentialFile 只读同一事实（自有目录是否存在），供 Core 启动使用，
不创建目录或密钥；只有 ENOENT 视为不存在，其他错误与非目录向上抛出。readAssignedCredentialsFile 读取进程装配的 ZCODE_CREDENTIALS_FILE：
空值视为未设置，非绝对路径直接失败。只有 Source Server Core 写入该变量；Desktop Main
启动时删除继承的该变量，Desktop 的 Main、Host 与 Agent 不采用它。

同一凭据目录的默认来源解析由 createSystemCredentialCipher 唯一负责，Server 与独立 CLI
均发现私有 credential-secret。系统库成功初始化时，在同一 keyring 锁内原子写入
credential-source（内容仅为 os，不含密钥），将来源固定到 OS；准备流程见到该标记后
不能另建文件密钥。已有 v2:os 记录也固定到 OS，来源/密钥失效不改用其他来源。
显式环境配置仍优先；来源选择与系统密钥加载共享同一个进程内 Promise。
缓存的密钥属于加载时的恢复代次：命中缓存时代次已变化，就丢弃缓存并在 keyring 锁内重新
加载。加载失败仍缓存到进程退出。

createLegacyServerCredentialCipher 仅用于旧 Supervisor 托管的更新候选 Core：已有 v2
则拒绝启动，只有 v1 时沿用旧加密/解密且不迁移。正常 Server 和独立 CLI 不选择此模式。
此兼容路径复用受管密钥解析，接受显式值、显式文件及私有约定文件。写入继续使用能
认证已有 v1 的历史密钥；新准备的随机文件不能抢先替换旧 fallback/trim 密钥。

enablePrivateFileKeyFallback 仅由 Desktop Main（全平台）在首次访问凭据前调用，返回是否生效；
已有密钥加载结果时不生效。开启后，keyring 锁内访问系统库失败且目录未绑定来源
（无 credential-source、无 v2 密文、无私有文件）时，排他发布 0600 credential-secret 并
使用它。已绑定来源的目录在本次请求中不切换；失败已缓存且阶段为 read、missing、invalid、
managed 时，后台按“凭据文件锁 → keyring 锁”复核并自动重置：需要清空时备份原文件（永久
保留）；每次重置都推进恢复代次（只解除绑定时也推进）；需要清空时写空库；删除
credential-source，managed 时移走坏的 credential-secret，最后清除该路径的失败缓存。
load 只指原生 keyring 模块 import 失败，不触发重置；模块已加载、创建条目对象失败归 read。onReset 在每次重置结束时报告 reset、skipped 或 failed。独立 CLI、Server
不开启。规格见上述 spec 的“Desktop 私有文件密钥回退与自动重置”。

writeCredentialRecordLocked 是凭据容器的唯一写入入口（Host 凭据服务与 CLI 共享存储），
调用方必须持有凭据文件锁。本次新产生的 enc:v2:os 密文要求 credential-source 为 os，否则以
CREDENTIAL_SECURE_STORAGE_UNAVAILABLE 拒绝且不写盘。磁盘上已有的值与 env 密文不检查。
先加密后写盘的调用方须在加密前用 withCredentialGeneration 领取恢复代次，由锁内代次屏障
保护到写盘：期间发生重置或损坏恢复时以 ZCODE_CREDENTIAL_STORE_CHANGED 拒绝且不写盘，
调用方按当前存储重试。该规则与加密在哪个进程（含经凭据桥由 Main 加密）无关。作用域只覆盖加密与锁内
写盘，提交后的变更通知须在作用域外执行，避免监听启动的后台任务沿用本次请求的代次。

默认密钥加载失败时，`CREDENTIAL_SECURE_STORAGE_UNAVAILABLE` 错误带受控 `diagnostic`
（`stage`、可选 `errorCode`、可选 `osCode`），不含密钥、路径或原生错误正文。
observeCredentialKeyFailures 注册进程级观察者，每次默认密钥加载失败只通知一次，
与失败缓存同一时机；显式 KeyStore 注入不通知。Desktop Main 在所有平台记录 warn。
诊断不进入凭据桥。规格见上述 spec 的“密钥加载失败诊断”。
