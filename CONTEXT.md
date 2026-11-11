# ZCode 插件商店（Plugin Store）

插件设置页及其市场浏览/安装体验的领域词汇表。2026-07 商店化重设计引入了一批容易混淆的术语，本文件是唯一裁决来源。

## Language

### 市场与来源

**Official Marketplace（官方市场）**:
ZCode 官方运营的唯一分发渠道，市场 id 为 `zcode-plugins-official`，内容 = 内置插件 + CDN 插件。是"分发渠道"而非"作者归属"——其中可以收录社区作者的插件。
_Avoid_: 把 claude-plugins-official 称作"官方市场"；"官方"泛指一切受信市场

**Builtin Plugin（内置插件）**:
随应用包一起分发、启动时播种进官方市场的插件。是官方插件的子集。
_Avoid_: 预装插件、bundled plugin（口语可用，文档统一"内置"）

**CDN Plugin（CDN 插件）**:
官方市场中通过官方 CDN 以 sha256 校验的 zip 包分发、按需下载安装的插件。
_Avoid_: 网络插件、在线插件

**Personal Source（个人来源）**:
用户自行添加的一切插件来源：claude-plugins-official、git/GitHub/URL/本地目录市场、inline 插件。
_Avoid_: 第三方市场（claude-plugins-official 也归此类，"第三方"名不副实）

**Catalog Auto-Refresh（目录自动刷新）**:
进入商店页时对 Official Marketplace 目录的节流后台刷新，用户无感知；只覆盖官方市场。
_Avoid_: 与 Manual Refresh 混用；把它称作"检查更新"（更新角标只是刷新的副产物）

**Manual Refresh（手动刷新）**:
商店页顶栏刷新按钮触发的全市场刷新，不受自动刷新节流影响。
_Avoid_: 刷新、检查更新（口语可用，文档统一"手动刷新"）

**Session Reload（会话重载）**：重建同一任务的运行实例，保留任务身份与历史。安装后的自动重载等待当前工作安全结束；不重放上一条请求。与刷新市场目录分别表述。

**Plugin Readiness（插件就绪）**：当前会话实际可以使用插件能力。安装成功、已启用和会话实例 ready 均不能独立证明插件就绪。

### 商店页结构

**Public Segment（公开）**:
商店列表页的分段之一，展示官方市场中由产品团队维护的条目；发布字段 `publisherType` 为 `official`，旧目录未提供时默认公开。
_Avoid_: 官方 tab、商店 tab

**Community Segment（社区）**:
官方市场收录的外部维护插件；从 `external_plugins/` 发布为 `publisherType: community`，与用途分类独立。

**Personal Segment（个人）**:
商店列表页的另一分段，展示全部个人来源的目录，按市场分组。
_Avoid_: 第三方 tab、我的 tab

**Featured（精选）**:
公开分段顶部的策展区，名单由官方 CDN 目录的 `featured` 字段远程控制。仅存在于公开分段。
_Avoid_: 与 Recommended 混用

**Recommended（推荐）**:
个人分段顶部的策展区，名单由仓内 `recommendedPlugins.json` 维护（当前推 claude-plugins-official 的精选插件）。仅存在于个人分段。
_Avoid_: 与 Featured 混用

**Manage Installed View（插件管理）**:
市场右上角的“插件管理”进入同一页面内的管理视图；保留全局默认和项目覆盖，可返回浏览并保留搜索、来源与管理范围。更多菜单仅暂停/启用与卸载，更新和恢复继承使用独立操作。

**UI Plugin（界面插件）**:
清单声明有效的 `ui.surfaces`，发布目录携带 `componentTypes: ["ui", …]`。未安装时使用目录能力，安装后以实际清单为准；暂停不改变分类。归属、用途和 UI 能力是独立维度。UI 专区和搜索均限定当前来源分段。

**Default UI Recommendations（默认界面推荐）**:
Side Pane 的独立精选名单，由客户端配置接口的 `uiPluginRecommendations` 下发，关联完整市场目录展示，未安装、未启用也可推荐；点击后分别安装、启用或打开真实面板。开发安装和用户安装不自动加入，与市场内完整 UI 专区不同。

### 元数据

**Store Listing（商店信息）**:
目录条目携带的展示性元数据：显示名、icon、分类、开发者、网站/隐私政策/服务条款链接、hero 图、示例提示词。描述"如何在商店里呈现"，不影响插件功能。
_Avoid_: 插件元数据（含糊，可能指 manifest）

**Plugin Manifest（插件清单）**:
插件包内 `plugin.json` 的功能性定义（commands/agents/skills/hooks/mcpServers/userConfig…）。描述"插件是什么、做什么"。
_Avoid_: marketplace.json（那是目录，不是清单）

**Example Prompt（示例提示词）**:
Store Listing 提供的可点击提示词，点击后新建会话并预填（不自动发送）。是详情页唯一的"新建会话"入口（原「立即试用」按钮已于 2026-07-14 移除）。
_Avoid_: 快捷指令、prompt 模板、立即试用

### 生命周期状态

**Plugin Lifecycle（插件生命周期）**:
用户从发现插件开始，经过查看、安装、配置、启停、使用、检查更新、升级、持久化恢复，直到卸载或恢复内置插件的完整产品路径。每个阶段都必须同时验证可见 UI 状态和对应的持久化或运行时结果。
_Avoid_: 仅把“安装成功”称为完整生命周期

**Restorable Builtin（可恢复内置插件）**:
被用户卸载并进入持久化抑制状态的 Builtin Plugin。应用重启不得自动重新播种；它继续出现在 Public Segment，并通过“安装”入口执行干净恢复。
_Avoid_: 未安装 CDN 插件、临时禁用的内置插件

**Orphaned Installed Plugin（孤立已安装插件）**:
对应 Personal Source 已被删除、但安装目录和用户数据仍保留的插件。它仍可使用、配置、启停和卸载；来源重新添加前不能更新，重新添加同一来源后恢复目录关联。
_Avoid_: 安装损坏、manifest 缺失、已卸载插件
