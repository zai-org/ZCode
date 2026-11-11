# Auth Login

## Project Access Token migration

OAuth account availability and request authentication must not read or decrypt legacy
account-provider API Keys. Valid persisted OAuth and identity records work even when
the old Key is absent or corrupt, including legacy records without an auth-source marker.
Only explicit manual mode reads the saved Key; it must not depend on an unrelated OAuth
credential being present or decryptable.

Dedicated Key management preserves the CLI's existing default-organization/default-project
selection, falling back to the first entry without filtering project types. BigModel
management requests retain the raw login JWT; Z.AI management requests retain Bearer.
Token issuance uses Bearer for both. The selection policy isolates persisted Key IDs
from the desktop personal-project policy. Unrelated malformed Key entries are ignored;
a matching personal Key with no ID fails without creating a duplicate.

Account-based Coding Plan key creation explicitly sends `usageScene: 1` for both
BigModel and Z.AI. This field describes intended usage, independently of `keyType`.
Manual API key login does not create a server key. List requests keep their current
unfiltered compatibility until the server's legacy-key mapping is confirmed.
The implemented token-only flow, storage boundaries, and acceptance cases are
defined in [the project credential spec](../../../../../docs/model-provider-project-access-token.md).

## Scope

The independent CLI discovers the same private `credential-secret` as the Server when
using the same credentials directory. Explicit managed configuration still takes
precedence. A successful OS-key initialization pins that directory to its OS source;
later remote preparation cannot change it before the first credential write.

ZCode CLI login uses the ZCode/Z.AI CLI OAuth device flow and shares the same
local credential store as the desktop Z Code product. The login boundary is a
CLI/bootstrap/adapter concern. Core runtime does not open browsers, call OAuth
HTTP endpoints, read environment variables directly, or write credential files.

This document is the v2 contract for:

- `zcode login`
- `zcode logout`
- `/login`
- `/logout`
- first-run TUI provider setup
- Coding Plan API key setup for Z.AI and BigModel

## Storage Contract

Desktop may rebuild a corrupt credential container only after explicit user confirmation
and a verified byte-for-byte backup. The CLI does not initiate this recovery. The shared
`credentials.json.recovery-generation` marker contains only a recovery revision, never credentials.
The container is decoded with fatal UTF-8 validation before JSON parsing, matching Desktop;
invalid bytes cannot be replaced and silently saved. Async reads recheck the revision before
returning; mutations capture it at admission and recheck it inside the existing file lock. A stale operation fails instead of returning old
identity or repopulating the recovered store. Ordinary concurrent saves still merge under
the same lock. Cross-request OAuth completion retains the initiating revision. CLI captures the store recovery guard before OAuth init and reuses it for both the login credential write and default-connection persistence. A recovery while initializing, polling or resolving access material rejects the old completion; it must not refill the empty store or update the default connection. A newly initiated login captures the current revision and may succeed. Default-config writes validate this revision at their commit point, after taking the config file lock and while holding the credential file lock. The lock order is config → credential; no credential lock is held while waiting for the config lock. This also fences normalization/import writes made by the config repository.
See [the recovery contract](../../../../../docs/ui/login-page.md#凭据容器损坏后的确认恢复).

Sensitive login state is stored in:

```text
~/.zcode/v2/credentials.json
```

The base directory follows the Z Code desktop convention:

1. Explicit data base dir passed by the caller.
2. `ZCODE_DATA_BASE_DIR`.
3. `os.homedir()`.

The file remains a JSON key/value container. System-backed encryption and migration
follow [the shared storage contract](../../../../../docs/plans/2026-10-29-system-credential-storage.md).
Desktop and CLI use one asynchronous cipher implementation. System-store failures
must preserve existing values and must not be treated as an expired login.

For desktop-managed execution, the CLI delegates credential encryption and
decryption to the connected Host over `interaction/requestCredentialCipher`;
the Host delegates to Desktop Main over its private parent port. Only Main
accesses the system key store. Neither IPC path carries the master key or logs
credential values. MCP OAuth storage and endpoint routing share this delegated
store; an unavailable Host must not fall back to direct OS key-store access.
Standalone CLI retains its own OS identity and caches key access (including a
denial) for the process lifetime; after unlocking, restart the CLI to retry.

The ZAI OAuth session keys are:

```text
oauth:active_provider       -> "zai"
oauth:zai:access_token      -> data.zai.access_token
zcodejwttoken               -> data.token
oauth:zai:user_info         -> JSON.stringify(data.user)
```

These keys are not the runtime model API key. They only preserve the Z.AI app
login state and allow the CLI to exchange the Z.AI access token for a Coding
Plan Project Access Token.

`zcode logout` snapshots shared OAuth keys, account identity/source pointers, and
only explicitly manual accounts' private model credential keys, then compares
the entire snapshot and deletes the whole group in one file-lock transaction.
Any changed value rejects the whole deletion; unchanged sibling fields must not
be deleted separately. A concurrent new login must not be
erased. Historical OAuth-derived keys (including corrupt ciphertext and records
without a source marker) are neither decrypted nor deleted during logout.

Host and CLI preserve the existing file format and jointly update
`oauth:session_revision` on OAuth mutations. Login captures its expected snapshot
before network authorization; its final commit replaces the active provider,
tokens and profile together, removes stale provider/refresh fields and rejects a
changed snapshot. A matching account/token is not sufficient to identify the same
login generation. Inactive Z.ai cleanup must not remove the active BigModel JWT.
Older binaries do not participate in this revision protocol; compatibility with
their stored values does not guarantee safe concurrent writes by old binaries.

OAuth setup stores the stable identity and `auth-source=oauth`; manual setup stores
`auth-source=manual` and its account-scoped API key. OAuth-derived short-lived
Tokens are memory-only. Non-secret Key IDs may be persisted by environment,
family, account, organization and project for the next token exchange:

```text
account-provider:<providerId>:identity
account-provider:<providerId>:auth-source
project-key-location:v1:<encoded-scope>  -> organizationId / projectId / apiKeyId
account-provider:coding-plan:<providerId>:account:<encodedAccountIdentity>:api-key
```

Provider IDs come from the current built-in account provider configuration.
The personal provider configuration records only the default provider/model
selection for this login flow. It does not receive the account API key.

## OAuth Flow

Base URL:

```text
https://zcode.z.ai/api/v1
```

`zcode login`:

1. Generate a local random `poll_token` with 32 random bytes encoded as hex.
2. Capture the store recovery guard and session snapshot, then confirm the
   encryption needed for the login write through the same key path as the first
   write. An unavailable credential store fails here with its original
   storage error: no `init` request, no `authorize_url` and no browser. On a
   usable store this may create the directory's key before authorization.
3. `POST /oauth/cli/init` with `Authorization: Bearer <poll_token>` and
   `{"provider":"zai"}`.
4. Show `authorize_url` and try to open it in the system browser.
5. Poll `GET /oauth/cli/poll/:flow_id` with the same authorization header.
6. Continue while `status` is `pending`.
7. On `ready`, persist credentials and patch non-sensitive model config.
8. On `failed`, timeout, or business error, report a retryable login failure.

The HTTP response envelope is:

```json
{
  "code": 0,
  "msg": "",
  "data": {}
}
```

`code != 0` is a business error even when the HTTP status is 200. Code `3004`
means the flow is invalid, expired, or the poll token does not match; the user
should start a new login.

## Provider Setup

When the TUI starts without a configured model API key, it must stay usable and
show a prominent non-modal login notice. The notice must not steal keyboard
input or force the setup picker open. Local commands such as `/help`, `/locale`,
`/mode`, bare `/skill`, and `/login` continue to work. Normal model prompts
return a clear "model not set, send /login to login" response until one of the
setup paths succeeds.

In the TUI layout, the login notice belongs to the composer area and renders
above the prompt input rather than above the transcript. The transcript remains
the conversation surface, while login setup guidance stays near the command the
user can type next. The notice title, message, helper text, related status, and
composer input title/placeholder must use the active TUI locale copy instead of
hardcoded English.

`/login` without arguments shows a local setup selection:

1. `Z.AI Coding Plan`
2. `BigModel Coding Plan`
3. `Z.AI Coding Plan API Key`
4. `BigModel Coding Plan API Key`

All four paths select the corresponding built-in provider/model. Only manual
Key setup persists model credentials; OAuth setup retains the login session and
stable identity, then resolves a Project Access Token before each HTTP attempt.

`Z.AI Coding Plan` reuses the ZAI CLI OAuth flow above. After Poll returns
`ready`, the CLI stores the existing ZAI OAuth session keys and exchanges
`data.zai.access_token` for a Project Access Token:

1. `POST https://api.z.ai/api/auth/z/login` with `{ "token": accessToken }`.
2. Use the returned biz token as `Authorization: Bearer <token>`.
3. Read customer org/project information.
4. Find or create an API key named `zcode-api-key`.
5. Issue `POST /api/biz/v1/organization/{org}/projects/{project}/api_keys/{id}/access_tokens`
   with the biz login JWT and `{clientType: "zcode", clientVersion}`.
6. Keep the Token in memory; persist only the stable user identity and OAuth source marker.

`BigModel Coding Plan` uses a local callback server rather than the desktop app
deeplink:

1. Bind an HTTP server to `127.0.0.1` on an ephemeral port.
2. Generate `state`.
3. Build the BigModel authorize URL with
   `redirect=http://127.0.0.1:<port>/oauth/callback/bigmodel`,
   `appId=zcode`, and `state`.
4. Show the URL in the TUI/CLI and try to open it in the system browser.
5. Accept callback query `authCode` or `code` plus `state`.
6. Exchange the code through `https://bigmodel.cn/api/auth/tokenByAuthCode`.
7. Use the returned access token to find or create `zcode-api-key`.
8. Use its `apiKey` ID and login JWT to issue a Project Access Token; never call Copy.
9. Derive a stable connection identity from organization/project metadata, independent
   of the rotating Token. Persist the login session, identity and OAuth source marker.

The callback server must validate state, return a short plain-text success or
failure page, close after success/failure/timeout, and never listen on a public
interface.

The manual API key options do not touch OAuth. In the TUI setup picker,
selecting either manual API key option keeps the `Set Up Coding Plan` panel
open and replaces the setup choices with an inline API key input. `Esc`
cancels that inline input and returns to the setup choices. `Enter` validates a
non-empty key, submits the matching `/login <provider>-coding-plan-api-key
<api-key>` command, and persists the private credential plus default model selection. When a
manual API key is submitted through the TUI, the local user transcript row must
redact the key and render only `/login <provider>-coding-plan-api-key
<redacted>`.

## Personal Configuration and Runtime Resolution

Setup uses `NodePersonalProviderConfigRepository` and
`NodeModelSelectionConfigRepository.saveConfiguredDefault` to update the selected
built-in account provider/model. The path is resolved from the explicit
`personalProviderConfigPath`, then `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, then
the shared personal provider configuration alongside the credential store.
Existing personal providers are preserved, including the supported legacy config
import on first write. OAuth tokens and account API keys are not written by
this setup flow into provider configuration.

At request time the account auth adapter resolves the identity and source marker.
OAuth resolves a cached or newly issued Token; a missing/failed OAuth session
cannot fall back to an old private API key. Manual setup resolves its private key. Legacy records with neither a source marker
nor an OAuth session require login or explicit manual Key setup again; the client
must not guess that an old derived Key was manually supplied. The public model registry is not the account key
owner. Manual third-party/custom provider configuration retains its separate
credential resolution contract.

Z.AI OAuth login uses the returned user identity. BigModel uses stable org/project
metadata. Manual Key setup retains its existing irreversible Key-derived identity.
Key ID records survive restart; explicit 404 invalidates the record for a new lookup.
A valid Token refreshes 120 seconds plus 0–60 seconds jitter before expiry.
Logout/account switch invalidates in-flight results and memory caches. Existing
OAuth and manual credentials used by older clients are not bulk-deleted.

## Browser Opening

The browser opener is an adapter-level external I/O operation:

- macOS: `open <url>`
- Windows: `cmd.exe /c start "" <url>`
- Linux/Unix: `xdg-open <url>`

If opening fails, login continues and prints the URL for manual opening.

## ZCode app-server And Headless Behavior

ZCode app-server cannot complete an interactive browser flow inside protocol handlers unless
the client provides an explicit UX. ZCode app-server should return guidance to run
`zcode login` locally.

Headless `zcode login --no-browser` prints the URL and polls normally, which is
useful for tests, SSH sessions, and remote terminals.

TUI `/login` must also emit the authorization URL as an assistant transcript
message as soon as Init returns. This is required for SSH and remote-terminal
usage where opening a browser on the host running the CLI may not be useful to
the human user.

When the user selects a browser-based setup option from the TUI setup picker,
the picker stays in place and replaces its option list with a waiting state.
The composer input must not reappear while the flow is waiting for the OAuth
poll result or localhost callback because normal prompts cannot succeed until
setup finishes. Pressing `Esc` in this waiting state cancels the in-flight login
through the propagated abort signal and restores the previous setup option
list. Manual API key choices are not long-running OAuth waits and may continue
to return usage guidance to the normal input flow.

BigModel Coding Plan login must emit the localhost callback authorize URL as an
assistant transcript message for the same reason. If the browser is not on the
machine running the CLI, the user may need to run the login in a local terminal
or use a future callback-paste fallback.

## Tests

Every test that invokes login or logout must inject a credential store in a
temporary directory, including endpoint and failed-authorization tests. Reading
a legacy credential store can migrate and rewrite it before OAuth starts; a fake
HTTP client or `noBrowser` does not isolate persistence.

Required coverage:

- Credential encryption, decrypt, plaintext compatibility, ZAI logout active
  provider behavior, and `ZCODE_DATA_BASE_DIR`.
- OAuth init/poll headers, envelope business errors, pending/ready/failed,
  and timeout.
- Failed authorization uses the injected temporary store and preserves its
  existing credential values through migration.
- Setup preserves personal providers and selects the built-in model. OAuth must
  not persist short-lived Tokens or read legacy derived Keys.
- Both families find/create `usageScene=1` dedicated Keys, use the ID for token
  issuance, and never call Copy.
- Key ID records remain account/environment/project isolated and contain no secrets.
- Missing OAuth and explicit `enable=false` fail without old-Key fallback.
- Logout discards late token results; manual API Key login remains independent.
- CLI `login`/`logout` wiring with injected bootstrap functions.
- Slash `/login` and `/logout` do not require creating a model app.

## Project Access Token 提前刷新容错

沿用共享 PAT owner。HTTP adapter 仅把结构化 network_error/timeout 和 HTTP 429/5xx 标记为临时故障；其他非 2xx 状态以结构化 HTTP 状态失败上报，2xx 但正文不是 JSON 记为 `project_token_invalid_response`，最终错误码按 `docs/model-provider-project-access-token.md`「换证失败错误码」映射，不携带响应体或 Token；提前刷新遇到这些故障时，允许在原 expiresAt 内复用未被拒绝的 PAT，5 秒退避，并记录脱敏事件。取消、401/403/404、畸形响应及未知错误不降级。模型 401 恢复携带的拒绝指纹先清除匹配 PAT，不会因此重用失败凭据。退出/账号切换必须拒绝迟到结果；不回退 API Key。验收覆盖临时故障、取消、过期、明确拒绝、并发及两 family 的成功码 0/200/字符串兼容。

Z.AI 前置业务 JWT 的 `ZaiBusinessTokenCache` 采用相同的临时故障分类与 5 秒退避，降级结果必须属于共享 pending。仅在 JWT exp / 响应 TTL 的最早期限内、同一登录且未被 invalidate 时复用旧值；无有效期元数据不降级。保留旧对象身份，确保迟到的 401 仍能将其标记为拒绝；clear/切账号拒绝在途结果。降级只记录固定 `project_token_business_login_refresh_deferred` 事件，不包含 JWT、OAuth 或响应内容。验收覆盖并发、退避恢复、原有效期边界、未知有效期、认证拒绝、取消及在途 clear/invalidate/换账号。

共享换证的生命周期属于 resolver/cache owner：Key ID 定位、PAT 签发/刷新/401 恢复与业务 JWT 换证 HTTP 都不携带单个调用方 signal，也不携带 context.abortSignal；保留 trace/logger，每次 HTTP 请求设置 15 秒超时。`resolve` 与 `resolveMaterial` 为调用方提供独立可取消等待，提前取消不发请求，等待中取消及时拒绝且移除监听器；不能让一个会话取消影响其他等待者或清空有效缓存。所有等待者退出后底层任务仍有超时，晚到失败必须消费；clear/登录代次保护不变。验收覆盖首个/后续等待者取消、并发共享、旧 PAT 刷新、401 恢复、Z.AI JWT 刷新、全员取消后的成功/失败、监听器清理和 logout 竞态。

中国区桌面登录使用 `oauth:zai_cn:*`，关联材料使用 `oauth:linked_bigmodel`。独立 CLI 本期不新增中国区交互入口；开始另一条全局登录或退出时，必须在同一事务删除这些旧会话字段，避免旧关联跨账号保留。
