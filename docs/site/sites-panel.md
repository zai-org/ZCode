# ZCode Sites 面板

Sites 面板是官方插件 `zcode-site` 自带的 UI plugin（MCP Apps），用来查看站点、部署记录、阶段日志、访问统计和用量，并改名、删除站点（改域名前缀只走 CLI `prefix`，由 Agent 执行，面板不提供入口）。部署本身仍由 Agent 通过 Skill + CLI 完成（CLI 鉴权见 [官方插件命令鉴权](../coding-plan/zcode-official-plugin-command-auth-spec.md)），面板不发起部署。

宿主不为面板加 Sites 专属代码，也不改共享协议：面板只用现有的 MCP Apps 能力，改动限于插件目录、官方插件的打包登记和服务端配置。

## 结构

```text
面板页面 ──readServerResource / callServerTool──▶ 插件 MCP server ──HTTPS + 官方身份头──▶ zcode-server /api/v1/sites/*
```

| 部分       | 位置                                                                       | 说明                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| MCP server | `apps/zcode-cli/packages/zcode-site-plugin/src/server` → `dist/server.mjs` | stdio，配置 `auth: {type: "zcode_official", provider: "jwt_token"}`                                                                     |
| 面板页面   | `src/ui` → `dist/ui/panel.html`                                            | 资源 `ui://zcode-site/panel.html`，官方 `@modelcontextprotocol/ext-apps` + React、lucide-react，脚本内联进页面；视觉照 Sites 面板原型   |
| 清单       | `.zcode-plugin/plugin.json`                                                | `mcpServers.sites`；`ui.surfaces: [{id: "sites", server: "sites", resourceUri: "ui://zcode-site/panel.html", availability: "session"}]` |
| 构建       | `scripts/build.mjs`（esbuild）                                             | 不复用 office-runtime 的构建脚本，只复用它收集第三方许可的 `licenses.mjs`                                                               |
| 登记       | `official-plugin-definitions.ts` 与三份打包清单                            | `componentTypes: ["ui"]`，`requiredSeedPaths` 带两个 dist 产物；桌面包、SEA、dev 的运行时构建登记，做法同 documents                     |

- **模型不可见**：工具全部声明 `_meta.ui.visibility: ["app"]`，不进入模型的工具列表；模型没有读 MCP 资源的工具；server 不返回 `instructions`。
- **身份**：宿主在发给 server 的每条消息的 `_meta["com.zcode/official-mcp-auth"]` 里附 `{ok: true, headers}` 或 `{ok: false, reason}`，`resources/read` 和 `tools/call` 都带。server 用它请求 zcode-server，不缓存、不落盘、不写日志；没有身份头时不发请求。请求 origin 用 `resolveRuntimeZCodeEndpointOrigin(process.env)`，与宿主校验官方 MCP 目标同一口径；`X-ZCode-App-Version` 取桌面端注入的 `ZCODE_APP_VERSION`；网络出口经 `http.setGlobalProxyFromEnv()` 读宿主给的代理变量。
- **套餐**：MCP 路径不支持「套餐可选」。没有 Coding Plan 连接的用户拿到只含 ZCode JWT 的身份头，可以正常使用；选中的 Coding Plan 连接已过期或类型不符时拿到 `official_auth_plan_required`，面板显示对应状态页。CLI 走命令端点的套餐可选模式，不受影响。

## 资源与工具

读操作是资源。宿主处理页面的资源读取时只校验归属，不经过工具审批，所以轮询不会弹审批。URI 以插件名开头，路径与 REST 一致：

| 资源 URI                                                              | REST                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| `zcode-site://usage`                                                  | `GET /api/v1/sites/usage`                                |
| `zcode-site://plans`                                                  | `GET /api/v1/sites/plans`                                |
| `zcode-site://sites?cursor=`                                          | `GET /api/v1/sites`                                      |
| `zcode-site://sites/{siteId}`                                         | `GET /api/v1/sites/{siteId}`                             |
| `zcode-site://sites/{siteId}/cover`                                   | `GET /api/v1/sites/{siteId}/cover`                       |
| `zcode-site://sites/{siteId}/analytics?range=`                        | `GET /api/v1/sites/{siteId}/analytics`                   |
| `zcode-site://sites/analytics/pv24h?siteIds=`                         | `GET /api/v1/sites/analytics/pv24h`                      |
| `zcode-site://sites/{siteId}/deployments?cursor=`                     | `GET /api/v1/sites/{siteId}/deployments`                 |
| `zcode-site://sites/{siteId}/deployments/{deploymentId}`              | `GET …/deployments/{deploymentId}`                       |
| `zcode-site://sites/{siteId}/deployments/{deploymentId}/logs?offset=` | `GET …/deployments/{deploymentId}/logs`                  |
| `zcode-site://commands`                                               | 读插件 `commands/*.md` 的 frontmatter 和用法，生成菜单项 |

资源内容是 `application/json`，`data` 原样取自 zcode-server 响应的 `data`；失败时返回 `{error: {code, reason, logid}}`，`code` 是 zcode-server 的错误码，`reason` 是没拿到业务响应的原因：宿主给的身份失败原因原样转交，另有 `unauthenticated`（HTTP 401，不重试）、`network`、`bad_response`。资源 URI 只放行上表的路径和查询参数（`cursor`、`limit`、`offset`），其他一律拒绝（`range` 只能是 `24h` / `7d` / `30d`，`siteIds` 最多 20 个站点 ID）。删除成功时服务端省略 `data`，server 统一返回 `data: null`。

写操作是工具，都由用户点击触发：

| 工具             | 参数               | REST                                           |
| ---------------- | ------------------ | ---------------------------------------------- |
| `rename_site`    | `{siteId, name}`   | `PATCH /api/v1/sites/{siteId}` `{name}`        |
| `set_site_badge` | `{siteId, hidden}` | `PATCH /api/v1/sites/{siteId}` `{badgeHidden}` |
| `delete_site`    | `{siteId}`         | `DELETE /api/v1/sites/{siteId}`                |

页面调用工具走宿主现有的审批链：每次弹审批，用户选「总是允许」后不再弹。删除标了 `destructiveHint`；会话在「完全访问」模式下宿主不弹审批，所以页面自己再确认：删除要输入站点名称才能确认。下线、再上线和部署不在面板直接执行，用菜单提示词交给 Agent。

## 打开与生命周期

- 面板只能手动打开，部署后不自动打开详情。入口有两个：侧栏「打开标签页」的内置入口「部署」（宿主写死插件 `zcode-site@zcode-plugins-official`，排在「辅助对话」前，见 `animatedSidePanePanelModel.ts`；不需要配 `uiPluginRecommendations`，配了会在「应用插件」里重复出现）；以及插件市场的「打开 UI」。草稿会话和远端工作区没有入口。中文界面名称为「部署」，英文为「Sites」。
- 只在 ZCode Desktop 的本地工作区可用。远程工作区（SSH / WSL / Docker）、Web 和手机打开时，宿主提示不支持；这些场景只用 CLI 部署。
- 面板实例按 workspace / session 隔离。当前页面和选中站点经 `ui/set-widget-state` 保存，切换会话后恢复，应用重启后回到列表。
- 主题和语言读 `hostContext.theme`、`hostContext.locale`，变化时只重绘，不重新请求数据。
- 样式只用宿主下发的 MCP Apps 标准变量（`hostContext.styles.variables`），不读宿主私有 token；宽窄布局用容器查询（520px 起标题与操作并排，600px 起用量三列）。

## 页面

| 页面       | 内容                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 站点列表   | 站点卡片：封面缩略图（只在列表显示，窄于 340px 时隐藏）、名称、域名（未发布显示「尚未发布」）、状态 · 相对时间、近 24 小时 PV（窄于 420px 时隐藏，没查出来显示「—」）、访问按钮；按名称和域名搜索；底部一行用量摘要，点击进入「用量与限制」；右上角「新建部署」分体按钮                                                                         |
| 站点详情   | 面包屑、名称与改名（对话框）、状态 · 发布时间、「重新部署」分体按钮与「访问站点」；失败或审核下线时的提示条；标签页「概览 / 部署记录 / 数据统计」                                                                                                                                                                                               |
| 概览       | 当前线上部署（域名与复制、发布时间）、访问数据（近 24 小时 PV、近 7 天 PV 与访客，「查看更多」进数据统计）、最近一次部署、设置（角标开关，不可移除时显示套餐与升级提示）、危险操作（删除站点）                                                                                                                                                  |
| 部署记录   | 每次部署一张卡片：标题为发起时间，下方状态与产物包大小；`isCurrent` 的标「当前线上版本」；不显示部署 ID                                                                                                                                                                                                                                         |
| 单次部署   | 在「部署记录」标签下打开：标题为发起时间，信息格为状态、产物包、完成时间，不显示部署 ID；四个阶段条；日志按 `offset` 增量追加，贴底跟随，用户上翻后暂停并显示「回到最新」；支持复制全部日志                                                                                                                                                     |
| 数据统计   | 区间「近 24 小时 / 近 7 天 / 近 30 天」（默认 7 天）、「数据更新于 x 分钟前」；浏览量 PV、独立访客 UV、平均访问时长、跳出率；PV / UV 趋势（同一纵轴，悬停显示每个桶）；热门页面、访问来源（空来源显示「直接访问 / 未知」）、设备（pc / mobile / tablet 映射文案）、地区的 PV 与占比；没有访问时显示「暂无访问数据」；`partial` 时提示数据不完整 |
| 删除站点   | 对话框：说明地址立即 404、不可恢复、本月用量不退；输入站点名称后才能删除。成功后回到列表并提示                                                                                                                                                                                                                                                  |
| 用量与限制 | 流量、存储、请求三张卡片：已用量 / 额度和进度条；套餐档位；超额时列出原因；统计周期与「数据可能有延迟」（不写具体分钟数）                                                                                                                                                                                                                       |

状态显示：

- `pending`：「尚未上线」，有进行中的部署时显示部署进度。
- `online`：「在线」。最近一次部署失败且有线上版本时，同时显示「站点仍在线」和「本次部署失败」。
- `offline`：「已下线」；带 `offlineReason: review_rejected` 时显示「内容未通过审核，修改后重新部署」，不提供再上线提示词。
- 角标开关读 `Usage.badgeRemovable`：false 时开关禁用，提示升级套餐后可关闭；`badgeVisible` 表示访客当前看到的效果。

不做：页面实时预览、本地构建日志、回滚。

## 菜单

菜单项来自 `zcode-site://commands`，不在页面里另存提示词。点击复制到剪贴板，并提示「已复制，粘贴到输入框发送」；不填输入框、不自动发送。面板资源在 `_meta.ui.permissions` 声明 `clipboardWrite: {}`。

| 位置             | 菜单项                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 列表「新建部署」 | `/site-deploy`；其余命令（状态、日志、下线、再上线、用量）不带站点                                                                                                  |
| 站点概览         | 重新部署、状态、下线或再上线（按当前状态二选一）、访问统计带站点 ID，如 `/site-status <siteId>`；日志带最近一次部署 ID（`/site-logs <deploymentId>`）；用量不带参数 |

## 外链

「访问站点」用 `openLink`，桌面端在应用内浏览器标签页打开；概览另有「复制链接」。

阶段一面板不提供套餐升级跳转：超额和角标限制只用文字提示用户升级套餐，升级后的权益以服务端下次返回的 Usage 为准。

## 轮询

状态只以服务端为准，不解析 CLI 输出，也不用超时推断状态。

- 列表和概览：有部署处于 `preparing` / `uploading` / `publishing` / `verifying` 时每 3 秒读一次，否则每 30 秒；错误条和状态页上有「重试」。
- 单次部署：未结束时每 2 秒按 `nextOffset` 读日志，`done` 后停止。
- 用量：进入页面时读一次，不轮询。套餐额度与权益表同时读 `zcode-site://plans`，档位与数值全部由服务端下发、按返回顺序展示，面板不写死；读失败只在表格位置提示并给重试，不影响上方用量。
- 封面：站点 `hasCover` 为真时按当前线上部署 ID 读一次，转成 data URL 缓存在页面里（宿主 CSP 只放行 `img-src data:`）；部署 ID 变了才重读。没有封面（还没截好、截图失败、审核驳回）显示占位图标。
- 近 24 小时 PV：列表每加载一页，把还没读过的站点按每批最多 20 个读一次；概览读当前站点。失败记为「—」，不报错不重试；手动刷新时重读（服务端缓存 10 分钟）。
- 访问统计：进入数据统计或切换区间时读一次，已有结果的区间不重读；返回 `computing` 时每 3 秒再读，最多 20 次（约 1 分钟），之后和 3613 一样在统计区域就地提示「稍后重试」，不弹全局错误条。概览只读近 7 天。
- 资源读取失败时保留已显示的数据，在顶部显示错误条，下一轮继续重试。

## 错误与状态

| 来源                                             | 面板表现                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| 身份 `official_auth_unavailable` / HTTP 401      | 未登录状态页，见下                                                            |
| `official_mcp_origin_untrusted` / `bad_response` | 同网络错误                                                                    |
| 身份 `official_auth_plan_required`               | 状态页「Coding Plan 已失效，续费或在设置里断开后可用；部署仍可让 Agent 完成」 |
| 3101                                             | 状态页「登录已过期，请重新登录 ZCode」                                        |
| 3609                                             | 状态页「插件版本过旧，请升级 ZCode」                                          |
| 3601 / 3602                                      | 「站点或部署不存在」，返回列表并刷新                                          |
| 3605 / Usage `canDeploy: false`                  | 用量页与列表底部标红，列出超额原因，文字提示升级套餐后恢复（不带跳转）        |
| 3608                                             | 角标开关回滚，提示当前套餐不能隐藏角标                                        |
| 3611                                             | 改名输入框下提示「名称未通过内容审核」，保留输入                              |
| 3612                                             | 同 `offlineReason: review_rejected`                                           |
| 3001                                             | 改名时提示名称不合法（长度 1–100）                                            |
| 3610                                             | 删除对话框提示「有进行中的部署，结束后再删除」                                |
| 3613                                             | 统计区域提示「统计暂时加载失败，请稍后重试」                                  |
| 3002 / 2001 / 2005 / 2007 / 网络错误             | 顶部错误条「暂时无法连接 Sites 服务」，带重试                                 |

用户可见文案只按 `code` 和 `reason` 生成，不展示服务端 `msg`；`logid` 放在错误条的详情里，便于排障。

未登录是用户第一次见到面板的入口，所以状态页不只报错，还要介绍这个能力：用列表空状态的 `Globe` 图标（不用警告图标），标题「登录后即可使用 ZCode Site」，下面一段介绍部署能力做什么，再一行说明部署仅限登录用户使用、请先登录。面板不能发起登录（宿主不为面板加 Sites 专属代码），所以只引导用户去面板外登录，动作仍是「重试」。其余三个状态页（`relogin` / `plan` / `appVersion`）保持单行提示：用户已经用过这个能力，不需要再介绍。

## 文案与 i18n

文案由页面自带，支持 `zh-CN` 和 `en`，按 `hostContext.locale` 选择，其他语言回落 `en`。键按页面分组：

| 前缀                 | 内容                                           |
| -------------------- | ---------------------------------------------- |
| `sites.list.*`       | 列表空状态、搜索、新建部署                     |
| `sites.site.*`       | 站点详情、概览字段、改名、角标、提示条         |
| `sites.analytics.*`  | 数据统计的区间、指标、分布、空与失败状态       |
| `sites.delete.*`     | 删除站点对话框                                 |
| `sites.deployment.*` | 部署记录与单次部署、日志操作                   |
| `sites.stage.*`      | 四个阶段名                                     |
| `sites.usage.*`      | 用量指标、套餐额度与权益表、延迟说明、升级提示 |
| `sites.menu.*`       | 菜单项名称、「已复制」提示                     |
| `sites.status.*`     | 站点与部署状态                                 |
| `sites.error.*`      | 上表各错误与状态页                             |
| `sites.login.*`      | 未登录状态页的标题、能力介绍与登录说明         |

## 验证

- 插件侧：server 的资源、工具和错误映射单测；页面测试照 documents 的 `test:pages`，覆盖握手、主题、语言和取消。
- 桌面：E2E 场景见 [Sites E2E 用例](sites-e2e-case-catalog.md)。
- 视觉：深浅主题、中英文、窄侧栏都要检查，规范见 `DESIGN.md`。
