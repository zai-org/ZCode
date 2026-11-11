# Sites E2E 用例

ZCode Sites 的端到端行为合同。CLI 链路（Agent 经 Skill 调 `zcode-site`）和面板链路（插件 UI plugin，见 [Sites 面板](sites-panel.md)）共用同一个 mock Sites 服务端，状态只来自服务端。

## 范围

| 边界       | 决策                                          | 理由                                       |
| ---------- | --------------------------------------------- | ------------------------------------------ |
| 服务端     | CI 用按 `api/openapi.yaml` 生成的 mock server | 不依赖真实 FC、OSS 和账号                  |
| 面板宿主   | 真实 Electron 中的 MCP Apps 宿主              | 面板的打开、隔离、剪贴板和审批都由宿主执行 |
| 远程工作区 | 只测 CLI 部署和面板「不支持」提示             | 交互页面只支持本地工作区                   |
| 真实服务端 | 联调阶段手动验证，不进 CI                     | 依赖两地部署与账号套餐                     |

## CLI 链路

### SITE-E2E-CLI-01：首次部署

- Setup：已登录、没有站点；项目里没有 `.zcode-site.json`。
- 操作：Agent 按 Skill 准备 stage 并执行 `zcode-site deploy`。
- 断言：创建站点并写绑定文件；输出依次经过 preparing → uploading → publishing → verifying → success；退出码 0。

### SITE-E2E-CLI-02：更新失败保留线上

- Setup：站点已有成功部署；mock 让下一次部署在 verifying 失败。
- 断言：CLI 退出码 4 并带失败阶段；`getSite` 的 `currentDeployment` 不变。

### SITE-E2E-CLI-03：下线与再上线

- 断言：`offline` 后站点状态为 offline；`online` 后恢复 online；审核驳回的站点 `online` 返回 3612、退出码 3。

### SITE-E2E-CLI-04：超出额度

- Setup：mock 的 Usage 为 `quotaState: exceeded`，createDeployment 返回 3605。
- 断言：退出码 3，错误 JSON 带超额原因和升级提示。

### SITE-E2E-CLI-05：未登录

- 断言：命令端点返回 401，CLI 退出码 2 并提示登录；env 和日志里没有凭证。

### SITE-E2E-CLI-06：远程工作区部署

- Setup：Docker 工作区。
- 断言：CLI 经 agent 侧命令端点部署成功。

## 面板链路

### SITE-E2E-PANEL-01：手动打开与列表

- Setup：本地工作区、已有会话。
- 操作：从侧栏「打开标签页」的内置入口「部署」（排在「辅助对话」前）打开面板。
- 断言：列表显示 mock 站点的名称、域名、状态和更新时间，没有 PV 列；没有工具审批弹窗（读走资源）；模型的工具列表里没有 `zcode-site` 的工具。

### SITE-E2E-PANEL-02：部署进度

- Setup：面板停在站点概览；CLI 在同一会话发起部署。
- 断言：面板没有被自动打开或切换；概览在轮询中显示部署推进到 success，部署记录出现新卡片并标为当前线上。

### SITE-E2E-PANEL-03：单次部署与日志

- 断言：阶段按日志推进；日志增量追加且自动跟随，上滑后暂停跟随；失败部署显示失败阶段和原因，并同时显示「站点仍在线」。

### SITE-E2E-PANEL-04：改名与角标

- 操作：在概览改名、关闭角标。
- 断言：每个工具调用弹出宿主审批，批准后生效并刷新；选「总是允许」后再次操作不弹；`badgeRemovable: false` 时开关禁用；mock 返回 3611 时保留输入并提示。

### SITE-E2E-PANEL-05：菜单复制

- 操作：点击「新建部署」菜单和概览的「日志」。
- 断言：剪贴板分别是 `/site-deploy` 和 `/site-logs <最近一次部署 ID>`；输入框内容不变，没有发出消息。

### SITE-E2E-PANEL-06：用量

- 断言：用量页显示三项进度和延迟说明；超额时列出原因和升级套餐的文字提示，没有升级跳转。

### SITE-E2E-PANEL-07：状态页

- 断言：未登录、Coding Plan 失效（`official_auth_plan_required`）、3609 各显示对应状态页；未登录状态页带能力介绍与「部署仅限登录用户使用」说明，其余两个只有单行提示；网络错误时保留已有数据并显示错误条。

### SITE-E2E-PANEL-08：多 session 隔离

- 操作：会话 A 的面板停在某站点日志，会话 B 打开面板停在列表，来回切换。
- 断言：两个面板各自保持页面，切换不重新握手。

### SITE-E2E-PANEL-09：关闭后重开

- 操作：部署进行中关闭面板，稍后重开。
- 断言：部署不受影响；重开后显示服务端最新状态。

### SITE-E2E-PANEL-10：远程工作区

- 断言：远程会话里打开 Sites 时提示不支持，不创建页面。

## 平台

CLI 和命令端点的测试在 macOS、Windows、Linux 都要跑；面板在桌面 E2E 中验证深浅主题和中英文。
