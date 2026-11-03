# ZCode Official Server MCP 鉴权与额度状态规格

> 状态：当前实现事实（2026-08-22）
>
> 本文是官方 Server MCP 客户端鉴权、HTTP/stdio 投递与额度状态的当前事实入口。
> 历史阶段设计保留在 phase-1 / phase-2 文档中，仅作 Decision Log，不再作为实现依据。
>
> 官方插件命令（`consumer: "plugin-command"`）复用同一个反向请求，规则见
> [zcode-official-plugin-command-auth-spec.md](zcode-official-plugin-command-auth-spec.md)。

## 1. 身份与职责

- Host/service 是用户凭证 authority；Renderer、relay、desktop main 不持有凭证。
- Agent 通过 `interaction/requestOfficialMcpAuthHeaders` 向 Host 请求本次身份头。
- 设置页使用独立的 `mcp-status` CLI。Host 在每次发送 `mcp/list` 前登记实际目标工作区，
  包括兼容重试和进程重建后的重试；管理进程的 cwd 不代表请求工作区。
- 仅 `mcp-status` lane 的合法 `mcp-server` 身份头请求（省略 consumer 时同义）可按该 client
  已登记的工作区路由，不要求它成为该工作区的聊天 owner。登记只由 Host 的出站入口建立，
  反向请求不得自行登记；聊天请求、通知与旧 runtime 的归属校验保持不变。
- 控制面授权仍先校验参数、精确工作区身份和可信 Origin，再读取凭证。未登记身份、非法参数
  和其他 consumer 不得借用该例外；进程退出时登记随 client 清理，不写入聊天 owner 表。
- HTTP MCP 由 adapter fetch wrapper 逐请求校验 origin；`server/discover`、`initialize`、notification、
  `ping`、`tools/list`、GET probe 与 `tools/call` 都向 Host 解析并注入当前身份头。解析失败时仍发送
  匿名请求，由服务端按请求方法权威判定；用户 entitlement 不应决定工具目录可见性。
- stdio MCP 在 `server/discover`、`initialize`、notification、`ping`、`tools/list` 与 `tools/call`
  的 `_meta["com.zcode/official-mcp-auth"]` 中取得当前身份载荷；凭证不得进入进程 env。
- `Authorization` 携带 ZCode JWT；`X-Bigmodel-Authorization` 携带当前 family 的 MaaS JWT。
- `X-Coding-Plan-Api-Key` 只属于服务端存量兼容通道，客户端不得发送或允许插件静态注入。

## 2. 产品 Scope 与 Wire Scope

套餐归属和实际请求头是两套语义，禁止用 wire 字段反推产品连接类型：

| 连接                    | planScope（额度归属）           | wireScope（身份头）             |
| ----------------------- | ------------------------------- | ------------------------------- |
| ZAI / BigModel Personal | `PERSONAL`                      | `PERSONAL`                      |
| BigModel Team           | `TEAM + organization + project` | `TEAM + organization + project` |
| ZAI Team                | `TEAM + organization + project` | `null`                          |

ZAI Team 的 wire 行为与 Off-Peak 保持一致：不发送 `Bigmodel-Target-Type`、
`Bigmodel-Organization`、`Bigmodel-Project`，由服务端 fallback 识别；但本地额度归属必须保持 TEAM，
否则 entitlement 的 Team request scope 会被错误判为 Personal 而跳过 `/api/v1/mcp/usage`。

缺少 organization/project 的旧或畸形 Team key 不得回退 Personal。工具调用可继续既有 fallback，
但不生成可精确归属的 quota scope。

## 3. 额度与 Banner

- HTTP 官方 MCP 服务端在请求进入路由时校验 ZCode 身份和 Coding Plan；客户端为连接、发现和
  调用请求统一携带可用身份头。已登录但无 Coding Plan 时只携带 ZCode JWT，不携带 MaaS JWT，
  由服务端返回协议层错误码；工具调用层的配额失败仍返回 `isError=true` 的结构化结果。
- HTTP adapter 若在任一请求发送前解析不到身份头，会以不含身份头的请求交给服务端做权威判定；
  不得把 `official_auth_unavailable` / `official_auth_plan_required` 提升为连接失败。
- `/api/v1/mcp/usage` 是 entitlement 的可选数据面，失败只清空 `mcpQuota`。
- 服务端 `total_usage` 映射为一条 `MCP_USAGE_LIMIT`；百分比保持“已使用占比”口径。
- quota scope 按 family、Personal/Team、organization/project 精确匹配。
- HTTP 官方 MCP 的结构化 `quota_exceeded` / `coding_plan_required` 可投影为 Composer banner；
  stdio 结果由插件进程产出，不作为可信 UI 事实。
- banner dismissal 以 `(sessionId, dismissKey)` 保存在当前 renderer 内存中，最多 256 条；
  不写 localStorage、Host、snapshot 或 relay，应用重启后允许再次提示。
- 同一 `(serverName, toolName)` 的新成功调用覆盖旧失败；新失败 rowId 形成新提示实例。

## 4. Remote 与审计

- workspace identity 使用 `workspaceIdentity?.trim() || workspacePath`；workspacePath 只用于执行/展示。
- Host 为每个 `(pluginId, mcpKey, workspaceKey)` 的首次身份头发放记录一条 info，后续走 debug。
- 授权回调在工作区路由阶段被拒绝时，Host 记录 lane、失败阶段、协议错误码与请求关联 id，
  不记录原始请求或凭证；成功发放日志带 lane，便于区分聊天与设置探测。
- 凭证解析成功必须以 info 记录 MaaS JWT 剩余有效期（只记秒数，绝不记 token）：MaaS JWT 无刷新
  链路，过期后服务端把上游 401 折叠成 `coding plan is required`，该数值是客户端唯一可自证的
  区分线索；生产构建 debug 不落盘，故必须 info。解析与官方 MCP 请求数同数量级，须以
  `(providerFamily, planTargetType, 有效期小时分桶 | expired | unparsable)` 为键去重——同键
  不重复记录；换 token、切换 PERSONAL/TEAM、跨桶（含跨过零点）必然产生新键。
- 审计集合必须有界；同路径不同 SSH/WSL/Docker identity 不得互相抑制。
- Host 校验只保证凭证流向当前 ZCode API origin；stdio 身份头进入插件进程是已知边界。

## 5. 验收不变量

- 未登录或登录态不完整时，HTTP MCP 控制面仍按现有匿名降级语义请求；已登录但无 Coding Plan
  时必须发送 ZCode JWT、不得发送 MaaS JWT，让服务端能够区分 `1006` 与 `3101`。
- 每次 HTTP 请求和官方 stdio 出站协议消息都重新解析身份；连接后登录、升级或退出无需重连即可
  在下一次请求生效。
- 匿名或无权益调用不得到达 gateway/upstream，不检查或扣减 quota，不写 usage。
- Origin 不可信仍在任何网络请求和凭证读取之前失败，不属于匿名降级范围。
- ZAI Team quota 可见，但 wire headers 与 Off-Peak 保持不变。
- Personal/Team/family/project 之间不串额度。
- 关闭同一 banner 后切换 session/pane 再返回仍隐藏；新失败重新显示。
- 最终 401 保存 server request id 后释放响应 body。
- Desktop continuous 与 Web remote replayable 交付语义不变。

核心用例：

| ID            | 场景                   | 断言                                                                  |
| ------------- | ---------------------- | --------------------------------------------------------------------- |
| OMCP-CALL-001 | 有有效 Coding Plan     | 连接、发现、GET probe 与 `tools/call` 都注入最新身份并成功            |
| OMCP-CALL-002 | 未登录或无 auth port   | 按匿名降级请求；服务端返回未认证错误时记录对应 request id             |
| OMCP-CALL-003 | 已登录但无 Coding Plan | 连接请求携带 ZCode JWT、不带 MaaS JWT；服务端错误可区分登录态与套餐态 |
| OMCP-CALL-004 | 连接后登录或升级       | 不重连；下一次调用重新解析身份并成功                                  |
| OMCP-STDIO-01 | 官方 stdio 已登录      | initialize、tools/list 与 tools/call 的 `_meta` 都携带当前身份载荷    |

设置探测回归（OMCP-SETTINGS，候选 E2E，不自动转正）：无聊天 runtime / 已有聊天 runtime
均可取得当前身份；A→B→A 与重叠请求保持目标归属、迟到结果不覆盖当前页面；未登记工作区、
同路径不同 identity、非法参数、其他 consumer 与旧聊天 client 仍被拒绝；探测进程重建后
重新登记；退出登录后刷新不复用旧凭证；手机 `/remote` 使用同一 Host，凭证不进入手机或 relay。
