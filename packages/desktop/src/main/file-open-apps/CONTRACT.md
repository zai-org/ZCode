# 文件关联应用

系统关联是唯一事实源。模块只接受本机真实文件；目录、远端身份和错误路径失败关闭。
查询不写入系统状态；默认标记来自系统，不从顺序推断。不透明应用 ID 不包含命令，打开时再次查询并匹配。
原生适配负责查询和启动；Windows 原生查询批量解析资源路径与带符号索引并返回有界 PNG，失败显式返回无图，不使用普通 EXE 文件图标冒充应用资源。macOS/Linux 仍由 IPC 调用方注入现有应用图标能力。图标失败不隐藏有效应用。
每次调用独立，没有跨工作区、文件或安装状态的持久缓存；不会创建 session、Host 或 Agent。

共享 WPS 启动器的 suite AppID 与当前 ProgID 分开保留；所有格式统一使用该 AppID 在 AppsFolder 登记的真实套件入口图标，保留独立 icon identity，不能回退 Writer 图标。名称与 public launch ID 不变，其它应用取图优先级不变。

经系统关联打开会执行文件的组合（当前平台的可执行类后缀，或 macOS 终端/脚本类应用）在启动前由注入的确认器询问用户；取消返回 `{ success: true, cancelled: true }`，不算失败。默认打开入口复用同一判定，规则见 `docs/file-preview-open-apps.md`。
