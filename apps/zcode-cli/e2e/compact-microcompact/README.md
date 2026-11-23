# Compact E2E

This harness runs real ZCode compact paths through the provider adapter, runtime, session events, and Docker-local request capture.

Default cases:

- `background-bash`: scripted provider, verifies foreground/background stdout-stderr write order, the single-path background result, and the exact completion notification sent to the provider.
- `bash-read-state`: scripted provider, Bash `cat` backfills read-state for `Edit`, then formatter Bash emits a stale read hint.
- `read-state-hash-resume`: scripted provider, isolated SQLite (`ZCODE_SESSION_DB_PATH`). Read/Write/Edit persist hash-only read-state snapshots (a ~21 KB file edit stays under 8 KiB per tool part); after cold resume a touched file passes `Edit`, a same-size content change is stale, and a pre-upgrade snapshot with full `content` (no `contentSha256`) still restores.
- `microcompact`: real `deepseek-v4-flash`, two Bash outputs, local MicroCompact projection.
- `manual-full-compact`: real model, `/compact`, post-compact continuation.
- `auto-full-compact`: real model, low auto-compact threshold, mid-turn full compact.
- `compact-ptl-retry`: scripted provider, compact summary prompt-too-long retry.
- `reactive-compact`: scripted provider, main request context overflow followed by reactive compact.
- `openai-responses-compact`: fake OpenAI Responses provider; main turns stream, compact first receives a deterministic streaming failure, then succeeds through a non-stream JSON fallback that omits the two compatibility fields.
- `usage-anchor`: scripted provider, verifies assistant `tokens` ownership across Full/Reactive Compact, input-only usage, empty-assistant cold hydration, and both kept/removed usage across conversation rewind. It checks live and hydrated runtime history directly; request `max_tokens` is retained only as capture evidence, not as the usage correctness assertion.
- `output-token-continuation`: scripted provider, verifies the real adapter HTTP sequence contains 0/1/2/3 exact Continue messages, ModelRequest events that record the same messages, real partial and hidden Continue persistence, empty exhaustion's zero-usage transcript error carrier without a fifth request, runtime survival, and a cold-resume request that starts with the last live request (Continue replayed, carrier excluded).

It is intentionally not part of the default test suite because real-provider cases need network access, a real API key, and provider spend.

## Local

From the repository root:

```bash
pnpm build
ZCODE_API_KEY=sk-... node e2e/compact-microcompact/run.mjs
```

Run only local scripted cases, with no API key:

```bash
node e2e/compact-microcompact/run.mjs --case=fake
```

Run only the output-token Continue E2E:

```bash
pnpm -r --filter @zcode/bootstrap... build
pnpm --filter zcode-cli exec tsx ../../apps/zcode-cli/e2e/compact-microcompact/run.mjs --case=output-token-continuation
```

This case awaits App creation and resumes the original session after both success and exhaustion.
It asserts restored history before the next prompt and `max_tokens=16000` on every captured request;
its Registry uses the declared 100,000-token context window. The focused helper regression runs with
`pnpm --dir apps/zcode-cli exec vitest run packages/bootstrap/tests/compact-e2e-case-utils.test.ts`.

Run only the background Bash E2E:

```bash
node e2e/compact-microcompact/run.mjs --case=background-bash
```

Run only the Bash read-state E2E from this monorepo worktree:

```bash
pnpm --filter zcode-cli exec tsx ../../apps/zcode-cli/e2e/compact-microcompact/run.mjs --case=bash-read-state
```

Run only the read-state hash cold-resume E2E:

```bash
pnpm -r --filter @zcode/bootstrap... build
pnpm --filter zcode-cli exec tsx ../../apps/zcode-cli/e2e/compact-microcompact/run.mjs --case=read-state-hash-resume
```

Run the fake OpenAI Responses compact compatibility E2E with no real API key:

```bash
pnpm --filter zcode-cli exec tsx ../../apps/zcode-cli/e2e/compact-microcompact/run.mjs --case=openai-responses-compact
```

Run one case:

```bash
ZCODE_API_KEY=sk-... node e2e/compact-microcompact/run.mjs --case=microcompact
```

Dry-run setup:

```bash
node e2e/compact-microcompact/run.mjs --dry-run
```

## Docker

```bash
docker build -f e2e/compact-microcompact/Dockerfile -t zcode-compact-microcompact .
docker run --rm -e ZCODE_API_KEY zcode-compact-microcompact
```

Run only the local scripted background Bash case in Docker, with no API key:

```bash
docker run --rm zcode-compact-microcompact --case=background-bash
```

To export artifacts from a disposable Docker run:

```bash
mkdir -p .tmp/compact-e2e
docker run --rm \
  --env-file .env \
  -v "$PWD/.tmp/compact-e2e:/artifacts" \
  zcode-compact-microcompact \
  --artifacts-dir=/artifacts
```

This writes:

- `result.json`: suite status and per-case summary, intended for scheduled task assertions.
- `capture.json`: index of per-case provider capture files.
- `events.json`: index of per-case runtime event files.
- `cases/<case>/capture.json`: OpenAI-compatible request/response capture.
- `cases/<case>/events.json`: ZCode runtime/session events.
- `cases/<case>/result.json`: focused case result.

The Dockerfile defaults to `node:24.14-alpine`. To use a local mirror or already cached Node image:

```bash
docker build \
  --build-arg NODE_IMAGE=node:24-bookworm-slim \
  --build-arg NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
  -f e2e/compact-microcompact/Dockerfile \
  -t zcode-compact-microcompact .
```

`@mbears` packages default back to `https://registry.npmjs.org/` because some mirrors may not sync private or scoped packages. Override `MBEARS_NPM_CONFIG_REGISTRY` only when your mirror has those packages.

If the provider request fails with `SELF_SIGNED_CERT_IN_CHAIN`, pass the CA trusted by your host:

```bash
docker run --rm \
  --env-file .env \
  -e NODE_EXTRA_CA_CERTS=/certs/provider-ca.pem \
  -v /path/to/provider-ca.pem:/certs/provider-ca.pem:ro \
  zcode-compact-microcompact
```

If your base image has working distro package repositories, you can also build with `--build-arg INSTALL_CA_CERTIFICATES=true`.

## Optional Args

```bash
node e2e/compact-microcompact/run.mjs \
  --case=real \
  --model deepseek-v4-flash \
  --base-url https://api.deepseek.com \
  --artifacts-dir=.tmp/compact-e2e \
  --keep-tmp
```

Case selectors accept `all`, `real`, `fake`, or a comma-separated list of case names.
