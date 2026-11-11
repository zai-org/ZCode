# cli-official-command-endpoint

官方插件命令（目前只有 zcode-site）要调用 zcode-server，但不能持有用户凭证（ZCode Sites 技术方案 5.8）。agent 进程起一个本地 HTTP 端点（POSIX 为私有目录下的 UDS，Windows 为命名管道），把地址和每个 session 的随机 token 经 `ZCODE_OFFICIAL_ENDPOINT` / `ZCODE_OFFICIAL_ENDPOINT_TOKEN` 注入该 session 的命令进程。

```text
CLI ──token──▶ 端点 ──认出 session、只放行 /api/v1/sites/*──▶ host 现取身份头（consumer=plugin-command）
                 └──▶ 补身份头与 X-ZCode-App-Version，流式转发 zcode-server ──▶ 响应原样流回
```

不变量：

- 环境包装必须保留底层执行端口的全部能力，含 ExecutionPort 接口之外的 Bash 后台生命周期与后台等待；显式后台和超时转后台都注入同一会话环境，底层不支持某个能力时不暴露。执行选项、返回值和错误原样传递，后台状态只由原执行器管理。
- 身份头只在本次转发的内存里出现，不缓存、不落盘、不进 env、不进日志；客户端带来的凭证头一律丢弃。
- token 只认本端点签发的，按 session 稳定；`close` 后全部作废。token 泄漏也只能在 agent 存活期间调放行的接口，拿不到 JWT。
- 端点自身的失败用 2007 加 `X-ZCode-Official-Endpoint-Error`；没有身份时返回不带响应体的 401，与 zcode-server 一致。
- 收到 `POST /api/v1/sites/{siteId}/deployments` 时，端点先回调该 session 的 observer，再取身份、转发，不看结果；create-app 据此打 `site_deploy`（docs/design/v2/model/session-features-header.md）。

与其它模块的交集：身份头的可信校验和凭证解析在 host（`zcodeAgentService` 与 `officialMcpCredentials`），本模块只调用 `interaction/requestOfficialMcpAuthHeaders`。
