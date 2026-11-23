# 预装工具契约

- `contract.ts` 提供浏览器安全的严格 schema；`node.ts` 提供发布路径与纯字节改写算法，不做 IO。
- catalog 是有序工具描述列表。资源使用 `platforms`、`binaryArch`、`archive`、`requiredFiles`、`entries`、`runtimeChecks`，不包含任何工具专用字段。
- catalog 只保存 `archive.path` 相对路径。Main 根据平台选资源，将路径拼到有序去重的下载基址列表上；默认基址按地域偏好排序，覆盖基址按配置顺序使用。Host 不接收 catalog。
- catalog 拒绝重复工具、重叠平台资源、不同工具共用入口、缺少入口目标、外部运行检查、完整下载地址、显式下载列表和地域分组。
- 无已发布资源仍保留工具描述，目标为 null；UI 不维护另一份工具列表。
- 下载基址不合法时，装配结果仍保留全部工具描述，目标均为 null，并返回基址错误供 Main 记录；不回退到其他基址。只有 catalog 本身不合法才整体失败。
- 初始化消息的 `tools` 为 null 表示清单不可用，与合法的空列表区分；预装进程据此跳过所有按 catalog 归属的回收。
- 资源内路径为无空段、`.`、`..`、盘符、反斜杠或 NUL 的相对路径。解压/文件校验还需保证实际路径不越界。
- 资源可声明 rewrite：每项包含安全相对 path、非空且不含 NUL 的 placeholder、text/binary/binary-dir-prefix mode。运行时只对本次 staging 执行改写，不把改写配置写入已发布安装记录。
- 安装记录固定在 `tools/<toolId>/installation.json`，保存发布时的必需文件与入口定义；预装进程是唯一写入者。
- 记录读取核对工具/平台/架构、版本目录与必需文件。入口是记录派生结果，不读取当前目标字段重建旧入口。
- 命令 prepare/cancel/delete 带 toolId；完整快照为 `{autoInstallEnabled, tools[]}`，准备阶段含 queued。
- preload、Main、utilityProcess 三侧运行时校验；命令回执只表示请求完成，不作为第二份 UI 状态。
- 安装记录不再包含 installationId、调用标记、删除门或删除意图记录；实际进程占用探针是删除的外部检查。
- `preinstalledToolArtifactSchema` 与归档身份 schema 供 `scripts/preinstalled-tools/` 公共制作与发布链路消费，资源格式与 App runtime 使用相同契约。

- 04：状态中的 installed 是有效安装记录的资源身份、版本与体积投影，独立于当前 target。target 为空但 installed 存在时仍为 ready；目标不同为 not-installed，由 UI 显示可更新。
- 每工具状态含 `agentEnabled`；`set-agent-enabled` 必须携带 toolId 和布尔值。disabled ID 列表只由本机预装进程写入，缺省全部开启。

- entryOutOfSync 独立于准备 error；sync-entries 只携带 toolId，表示按已保存事实重建入口，不表示重新下载。

- 目录前缀模式保持占位槽的字节宽度，以 / 补齐，逐处拒绝后继不是 /、NUL 或 EOF 的出现。公共 Node 字节算法同时供制作检查与安装器使用；错误码 unsupported 只表示 UTF-8 路径超长，安装 owner、取消与重签仍由桌面模块负责。Windows 资源不能声明目录前缀模式。
