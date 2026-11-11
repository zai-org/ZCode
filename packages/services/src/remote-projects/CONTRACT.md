# 本机远端项目入口

本机 SQLite 是“用户添加了哪些远端项目”的唯一权威。远端项目 CRUD 继续走远端 project 服务。入口仅保存基础信息，不保存会话索引、归属、消息或待执行操作。连接运行态与凭据沿用既有服务。

入口缓存包含远端项目的删除态（`cached_deleted`）。在线刷新随名称和 roots 一起写入；显式添加表示项目可用，写为未删除。离线或远端读取失败时，侧栏用缓存生成项目行，已删除的入口不展示，settings 兼容投影也不导出它。删除态只是远端事实的缓存，本模块不据此删除入口，也不触发远端写入。

新增是明确用户动作，刷新只更新已有 entry ID，并比较请求开始时 lastSyncedAt。移除后重新添加产生新 ID，旧网络响应无法复活或覆盖新入口。并发刷新仅一个版本可提交，其余下一次刷新重读。移除 host 仅级联本机入口，事务中执行；保存 host 和确认不同 Source 均在事务内写入，不设保存数量硬上限。所有变更经 afterChange 在当前 Host 发布，桌面与手机读取同一份本机数据，不创建新 runtime 或消息恢复路径。

schema 由 project-storage 的启动迁移准备。本模块仅操作 hosts 与 remote_project_entries；工厂注入已迁移的连接，不打开第二个数据库，不接触 CLI。settings 双写由装配层从提交后的入口快照派生，不能把旧 settings 再次导入。

直接连接远端 owner 的客户端没有本机 Controller 入口表。装配时以 controller=false 禁止全部入口写入，readDirectory 返回空目录且不访问数据库；当前 owner 的权威项目仍从 projectService 读取。不能因为查询不支持 Controller 入口就把整个权威项目树拒绝掉。

历史影子 host 的 target_json=NULL 占位不属于连接入口，不展示。未改变缓存内容的刷新仍推进 CAS 版本，但不广播项目变化。

connectHost 从成员表取得已保存连接，再通过装配端口调用既有连接器的 retain 路径；自身不加载凭据、不重试、不创建 Host/runtime，不增加入口。readDirectory 可附加连接管理器提供的当前 connectionStatus，字段仅为实时展示投影，禁止落盘或成为连接实例的第二 owner。

连接成员实例由 membership_id 标识；显式移除/重加换代。握手 bindHost 比较开始时的实例 ID，条件不匹配不得插入。旧地址与稳定 Source 合并时只迁移本机入口，重复的已解析项目保留目标现有 entry ID；旧稳定 Source 不允许直接改绑成另一个稳定 Source。连接实例和 Profile 路由依然归既有连接管理器/Directory。

createRemoteProjectConnectionAdmission 为装配层提供 probe 前 admission / online 前 commit 的窄端口，自动连接只读成员关系。bindHost 的 createDistinctHost 仅供既有身份更换确认通过后使用：条件匹配时新增独立 Source，保留旧 Source 与入口，不迁移归属。

releaseRemoteProjectProfileHost 是 admission 的对称释放：未识别线路（无 sourceServerId）删除或改址后，若没有其他未归档线路映射到同一地址、且地址行没有入口，移除该预留行。已识别线路直接返回；有入口的旧迁移行保留，只由用户显式移除连接。地址不能构成成员身份（如 IPv6 主机）的线路从未写入预留，释放对它是空操作，也不参与同地址比较。

remoteProjectHostIdForProfile 用于 admission，身份无效时抛错并拒绝连接；findRemoteProjectHostIdForProfile 用于按线路枚举成员行（释放、连接状态投影、connectHost 选线），身份无效时返回 null，表示该线路不拥有成员行。枚举时不能用会抛错的版本，否则一条无效线路会让整个枚举失败。

旧 workspace 入口首次匹配项目时，仅接受同 Host 唯一包含该 cwd 的项目；零匹配或多匹配保留原入口等待用户选择。若多个旧入口解析到同一项目，保留已经解析的 entry ID 并去除重复旧入口，迟到响应不能再通过旧 ID 写入。

连接器在 admission/commit 每次等待后复查取消和物理连接 owner。未发布 socket 由当前 connect 调用独占并在统一 finally 释放，直到成功移交 online map；关闭回调只能影响它实际拥有的 online 对象，不能使另一条已在线连接离线。

连接状态端口同时投影当前错误和原状态名，online 后不得回退读取旧持久错误。项目连接日志使用 hostId+membershipId 关联现有连接进度上下文，UI 只消费当前成员；该 key 不是 workspace 身份，不参与任务/队列隔离。
