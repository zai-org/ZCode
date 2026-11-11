# 上游供应商 E2E

`packages/desktop/test/e2e/infrastructure/smoke/upstream-provider.test.ts` 是 E2E 上游供应商的固定回归 case。
供应商的地址、API key 与模型名都由环境变量控制，仓库不写死任何供应商。

它会通过桌面端设置页写入 E2E 供应商，添加主模型，回到工作区后选择该模型并发送请求。默认模式不访问真实网络，而是启动本地 fixture replay server，把已采集过的真实响应作为 HTTP 内容回放，保证固定 case 可以稳定复现。

## 环境变量

| 变量 | 作用 | 未设置时 |
| --- | --- | --- |
| `E2E_PROVIDER_BASE_URL` | 上游供应商地址 | capture 模式报错；回放不需要 |
| `E2E_PROVIDER_API_KEY` | 上游 API key | capture 模式报错；回放固定使用 `e2e-fixture-key` |
| `E2E_PROVIDER_MODEL` | 主模型名 | 回放夹具的录制模型 |
| `E2E_PROVIDER_SECONDARY_MODEL` | 第二个模型名（模型切换、备用供应商等 case） | 回放夹具的录制模型 |
| `E2E_PROVIDER_PRESET` | `env`（默认，上面四个变量）/ `glmhighspeed` / `bigmodel53` / `stagingmodel` | `env` |

- 录制模型只在 `packages/desktop/test/e2e/helpers/upstream-recorded-models.ts` 定义一次。产品内置模型规则按模型 ID 匹配思考档位与请求形态，夹具按录制模型采集；更换默认模型需要重新录制夹具。
- `E2E_PROVIDER_RUNTIME_BASE_URL` 是 WDIO 写给各测试进程的实际生效地址（回放时指向本地 replay server），不要手动设置。
- 设置页“新增供应商模板”等用例验证的是产品内置模板（含 DeepSeek），不属于 E2E 供应商配置。

## 默认固定回放

直接运行指定 spec 即可：

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/infrastructure/smoke/upstream-provider.test.ts
```

默认回放模式的行为：

- WDIO 启动本地 replay server，并把 E2E 供应商的地址指到该 server。
- API key 会强制使用 `e2e-fixture-key`，不会读取或泄露本地真实 key。
- 固定响应来自 `packages/desktop/test/e2e/fixtures/upstream/provider-basic.json`。
- WDIO 会在隔离 HOME 里预置主模型与第二模型；新增会话状态隔离用例复用这份 fixture，避免把 provider 设置页“新增模型”当成会话区测试前置条件。
- 请求抓包 artifact 写到 `packages/desktop/.e2e-home/.zcode/e2e-network-capture/upstream-provider.json`，认证 header 和 token 字段会脱敏。
- case 同时校验 UI、请求 body、思考深度字段，以及 context 消耗是否等于 fixture 中真实响应的 usage。

这个 case 是“采集一次，固定回放”的回归：fixture 内容来自真实上游请求，但默认执行时不再依赖账号余额、上游限流和模型实时可用性。

## 采集真实数据

需要刷新 fixture 时，显式切到 capture 模式，并用环境变量给出上游地址、key 与模型。刷新现有夹具时，模型需要与录制模型一致：

```bash
E2E_PROVIDER_HTTP_MODE=capture \
E2E_PROVIDER_BASE_URL=https://<provider-host>/anthropic \
E2E_PROVIDER_API_KEY=... \
E2E_PROVIDER_MODEL=<model-id> \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/infrastructure/smoke/upstream-provider.test.ts
```

capture 模式会在本机启动透明 MITM 抓包代理：

- provider endpoint 仍是真实地址；性能样本默认推荐 `glmhighspeed` preset。
- 代理只转发和抓包，不合成模型响应。
- CA 只生成在 `packages/desktop/.e2e-home/.zcode/e2e-network-capture/ca`，不会写入系统证书库。
- WDIO 会把 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` 注入到 e2e 进程树。
- 抓包 artifact 写到 `packages/desktop/.e2e-home/.zcode/e2e-network-capture/upstream-provider.json`。
- artifact 会额外记录 `responseChunkTimeline`，保存 response chunk 的相对时间和 bytes；用于之后按真实 SSE 节奏回放。

采集完成后，把脱敏后的响应整理成单 case fixture。固定 case 不直接依赖最新线上响应；动态网络回归需要单独命名和显式运行。

## 采集长流式性能样本

默认 replay 仍使用仓库内录制的 fixture，保证固定 provider 回归不访问真实网络。需要录制长 Markdown 流式性能样本时，可以显式指定
`E2E_PROVIDER_PRESET=glmhighspeed`。该 preset 使用
`https://open.bigmodel.cn/api/anthropic` 和模型 `glm-5.1-highspeed`。
GLM highspeed preset 默认不选择思考深度，也不会断言 thinking 字段；录制 fixture 回放和 `env` preset 默认选择并断言 `high`。

```bash
E2E_PROVIDER_HTTP_MODE=capture \
E2E_PROVIDER_PRESET=glmhighspeed \
GLM_HIGHSPEED_E2E_API_KEY=... \
E2E_PROVIDER_PROMPT='输出一篇很长的 Markdown，包含多级标题、列表和代码块，末尾写 PERF_TRACE_DONE' \
E2E_PROVIDER_EXPECT_REPLY_TEXT=PERF_TRACE_DONE \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/infrastructure/smoke/upstream-provider.test.ts
```

后续回放自定义 fixture 或 capture artifact：

```bash
E2E_PROVIDER_PRESET=glmhighspeed \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=/absolute/path/to/upstream-provider.json \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/infrastructure/smoke/upstream-provider.test.ts
```

当 replay fixture 带 `response.chunks`，或直接使用含 `responseChunkTimeline` 的 capture artifact 时，
本地 replay server 会按原始 chunk offset 流式写回响应，而不是一次性返回完整 body。

## 本地配置

只有 capture 模式和真实 provider smoke 需要真实地址与 key，仓库不提供默认值。
WDIO 按顺序读取 `packages/desktop/.env.e2e.local`、根目录 `.env.e2e.local`；shell 里显式传入的值优先。
根目录 `.env.e2e.local.example` 只列出变量名、值留空，不作为 fallback 读取。推荐写到本地忽略文件里：

```bash
cp .env.e2e.local.example .env.e2e.local
```

然后在 `.env.e2e.local` 里填写地址、key 与模型。GLM highspeed 录制优先读取
`GLM_HIGHSPEED_E2E_API_KEY`，也兼容 `BIGMODEL_API_KEY` / `ZHIPUAI_API_KEY`。

`*.local` 表示本机私有配置，适合长期个人 API key，已被 `.gitignore` 忽略；不要把真实 key 写进可提交的 `.env.e2e`。
