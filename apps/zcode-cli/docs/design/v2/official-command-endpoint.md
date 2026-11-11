# Official Command Endpoint

## Goal

Let the command-line tools shipped in official plugins (today only `zcode-site` from the ZCode Sites plugin) call the ZCode API with the signed-in user's identity, without the tool ever holding a credential.

A command runs in the session's Bash. Every process in that session can read its environment, so a ZCode JWT or MaaS JWT placed in the env could be copied by any other command. The agent therefore keeps the credentials and acts as a narrow proxy. The host-side resolution and protocol are specified in `docs/coding-plan/zcode-official-plugin-command-auth-spec.md` at the repository root.

## Layering

- Module: `cli-official-command-endpoint` (`packages/bootstrap/src/official-command-endpoint/`, adapters layer). Its public surface is `contract.ts` and `index.ts`.
- `zcode-protocol-entrypoint.ts` creates one endpoint per agent process, wires its identity source to `createOfficialCommandAuthHeadersPort` (the reverse request `interaction/requestOfficialMcpAuthHeaders` with `consumer: "plugin-command"`), and closes it on shutdown.
- `create-app.ts` wraps each session's `ExecutionPort` with `withOfficialCommandEnv`, so foreground and background Bash runs carry the session's endpoint env. It passes the session's workspace (`workingDirectory` and `runtimeConfig.memory.workspaceIdentity`, the same pair the session's MCP connections use) to `envForSession`.
- 包装层通过 `@zcode/core` 公开的能力接口与检测函数（`supportsBashBackgroundLifecycle`、`supportsBackgroundTaskWaiter`）保留底层后台能力。`runBashWithBackgroundLifecycle` 的显式后台和超时转后台请求都经过同一个环境注入函数，`waitForBackgroundTask` 原样透传；模式、执行选项、结果与错误原样传递，底层不支持某个能力时不暴露该方法。后台状态仍由原执行器唯一管理。
- 回归证据：这两个能力都在 `ExecutionPort` 接口之外，漏传不报类型错误。漏传 `runBashWithBackgroundLifecycle` 时，`officialCommandEnv` 在 agent 进程里无条件接线，于是每个 session 的显式后台 Bash 都抛 `ConfigurationError`（`ExecutionPort does not support the Bash background lifecycle`），超时转后台退回普通前台执行，既没有 task id 也没有完成通知；漏传 `waitForBackgroundTask` 时后台追踪退回 1 秒轮询，完成通知晚于同一轮 tool-loop 的下一次模型请求。
- Outbound requests use `createMcpTransportFetch`, the same network policy (proxy, CA) as HTTP MCP.

## Environment variables

| Name | Value | Set by |
| ---- | ----- | ------ |
| `ZCODE_OFFICIAL_ENDPOINT` | Endpoint address: a Unix domain socket path on macOS/Linux, a named pipe (`\\.\pipe\zcode-official-<pid>-<random>`) on Windows | Agent, per execution request |
| `ZCODE_OFFICIAL_ENDPOINT_TOKEN` | Random per-session token (32 bytes, base64url) | Agent, per execution request |

- Precedence: the agent's execution overlay always wins over a value already in the request's `env.set`. Both keys are in the sanitized runtime env list, so values inherited from the agent's own parent process are dropped and never reach commands.
- Requests with `env.base: "empty"` are intentionally clean and get neither key.
- The endpoint starts listening lazily on the first `envForSession`. If it cannot start, the command still runs without the keys and the warning `zcode_protocol.official_command_endpoint.env_unavailable` is logged.
- A command that finds either key missing must fail as "not signed in / not inside a ZCode session". `zcode-site` exits with code 2 and error `UNAUTHENTICATED`.
- No config file or CLI flag controls these values; they exist only to hand a session-scoped capability to child processes.

## Request handling

```text
command ──Bearer <session token>──▶ endpoint
  token unknown ─────────────────────────▶ 403, error header "invalid"
  path not under an allowed prefix ──────▶ 403, error header "invalid"
  host identity: unavailable or throws ──▶ 401, empty body, error header "unauthenticated"
  host identity: other failure ──────────▶ 502 "auth"
  forward to <ZCode API origin><path> ───▶ fetch error ─▶ 502 "network"
                                        └▶ stream status, headers, body back
```

- The identity request carries the workspace recorded for the token's session, with `workspaceKey = workspaceIdentity || workspacePath`. The host routes the request by this workspace to a workspace the CLI owns, so it must never be the agent process cwd: a shared CLI (`shared-local-tasks`) runs in a directory that is not a workspace, and the host rejects such requests. The workspace only routes and audits the request; the identity is the host's global sign-in, so a session in workspace A can still deploy a stage directory from project B.
- When the reverse request throws (the host rejects it, or the transport fails), the port answers `official_auth_unavailable` and logs the warning `zcode_protocol.official_command_endpoint.auth_request_failed` with the error message and `workspaceKey`.
- Allowed prefixes are `OFFICIAL_COMMAND_ROUTES` in `contract.ts`: only `/api/v1/sites` for plugin `zcode-site`. A prefix matches on a path-segment boundary. The path is normalized by URL parsing first, so `..` segments cannot escape the prefix.
- Only `accept`, `content-type` and `content-length` are taken from the command. Identity headers come from the host for every request and are never cached; `X-ZCode-App-Version` is set by the agent. Client-supplied `Authorization`, `Cookie`, `X-Bigmodel-*` and similar headers are dropped.
- The request body is streamed (`duplex: "half"`) with the original `content-length`. When an HTTP proxy is configured, the proxy fetch buffers the body.
- Response headers `connection`, `content-encoding`, `content-length`, `keep-alive`, `set-cookie`, `transfer-encoding` are dropped. The body is streamed with backpressure. If the upstream fails midway, the command's connection is destroyed so the command sees an incomplete response.
- Endpoint-generated errors use the zcode-server envelope `{code: 2007, msg, data: null, logid: ""}` with header `X-ZCode-Official-Endpoint-Error: invalid | auth | network`. The bare 401 carries the same header with `unauthenticated`.
- `envForSession(sessionId, workspace, observer)` records the observer for the session. When the endpoint receives `POST /api/v1/sites/{siteId}/deployments` from a known session, it calls `observer.onSiteDeploymentRequested()` before it asks for identity and forwards the request, whatever the result. `create-app.ts` records the `site_deploy` session feature from it (`docs/design/v2/model/session-features-header.md`). Subagents share the parent session's token, so their deployments count for the parent session.

## Lifetime

- One endpoint per agent process, shared by its sessions. A session's token is stable for the life of the endpoint; each `envForSession` call records the latest workspace for that session.
- On POSIX the socket lives in a fresh `mkdtemp` directory, private to the user (mode 0700).
- `close()` invalidates all tokens, closes open connections, stops listening and removes the socket directory; it can be called more than once.

## Known limits

- Workflow and script child runtimes that build their own execution adapters do not get the env.
- With an HTTP proxy configured, deployment packages are buffered in memory before upload.

## Tests

- `packages/bootstrap/tests/official-command-endpoint/endpoint.test.ts`: per-session tokens and private socket dir; each token asks for identity with its own session's workspace; the port builds `workspaceKey` from identity or path and logs `auth_request_failed` when the host rejects; rejected tokens and paths never reach the host; header replacement and streamed 3 MB upload; 401/2007 mapping; unreachable upstream; close removes the socket; the observer is called for every deployment request of the token's session and for no other call; `withOfficialCommandEnv` merge, `base: "empty"` and failure behavior; the auth-headers port request shape.
- `packages/bootstrap/tests/session-features-site-deploy.test.ts`: with a real endpoint and a fake zcode-server, a deployment request adds `site_deploy` to the next model request even when zcode-server rejects it.
- `packages/bootstrap/tests/official-command-endpoint/contract.test.ts`: module manifest and public entrypoint.
- `packages/zcode-site-plugin/test/zcode-site.test.mjs`: the CLI reads only the two env keys, sends only the session token, maps the `network` error header, and talks HTTP over the socket.
