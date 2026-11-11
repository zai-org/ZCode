---
name: e2e-case-lifecycle
description: Plan, maintain, replay, and promote ZCode desktop E2E cases and their fixtures, coverage matrices, and CI admission evidence.
disable-model-invocation: true
---

# E2E Case Lifecycle

Use this skill for the z-code E2E lifecycle: manual-review automation, capture/replay evidence, formal fixture promotion, Docker admission, and CI. It is intentionally domain-neutral: use it for conversation flows, SSH, provider settings, UI workflows, filesystem behavior, remote runtimes, auth/config, and similar product surfaces. Work from the z-code repo root.

目录分类遵循 `docs/testing/e2e-business-scenarios.md`。转正保留业务场景目录，只移除 `manual-review/pending`；fixture 仍按 caseName 索引。

## Required Reading

Before writing or moving an E2E spec, read the relevant sections of the domain's case catalog, coverage matrix, and workflow docs. For conversation-session work, the default sources are:

- `docs/conversation-session-case-catalog.md`
- `docs/testing/conversation-session-e2e-coverage-matrix.md`
- `docs/testing/conversation-session-e2e-development-workflow.md`

If the request involves SSH, provider settings, auth/config, fork, goal, fault, model switch, or remote/replayable semantics, also read the matching matrix/spec document under `docs/testing/` or the nearest feature docs.

## Coverage Planning

For open-ended feature changes or "what should we cover?" requests, use
`feature-boundary-planner` first. Return here only after accepted cases
exist in the catalog/matrix.

When asked what to test:

1. Extract state dimensions from the feature spec, catalog, and matrix.
2. Enumerate combinations, then prune invalid or duplicate cases with the user.
3. Write accepted/undefined/pruned decisions into catalog or matrix docs before code.
4. Only generate E2E code for accepted semantics. If product behavior is undefined, stop at a question or doc update.

Do not claim coverage from a path that merely passes through a state; each covered case needs setup, action, and assertion.

A matrix row may say `covered` only when it cites the artifact of a run in which that case passed, for example `packages/desktop/.e2e-artifacts/desktop-e2e-<run-id>`. A new assertion that never ran does not count: if an earlier step or a known baseline failure stops the case first, keep the row `partial` or `failing`, write `blocked by <baseline id or symptom>`, and list the assertions that did not run. Update the row again when a passing run exists.

## Manual Review Case

For a new candidate case:

1. Put the spec under the domain's `manual-review/pending/` directory. For conversation-session this is `packages/desktop/test/e2e/conversation-session/<scenario>/manual-review/pending/`.
2. Use stable `E2E_*` markers in user prompts and provider matchers.
3. Prefer existing helpers in `packages/desktop/test/e2e/helpers/`.
4. Use `buildReadonlyToolPrompt(...)` for high/medium priority completed-history setup unless timing makes tool history counterproductive.
5. Run manual/capture with:

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts'
```

Manual/capture artifacts are review evidence, not the final test contract.

When a feedback reproduction run needs a video artifact, record the Electron
window from inside the app instead of using OS screen recording. Import
`startElectronWindowRecording` and `ELECTRON_WINDOW_RECORDING_CAPTURE_MODE` from
`#e2e/helpers/electron-window-recorder` in conversation
`manual-review/pending/` specs, start recording before the user-visible path,
stop it in `finally`, and write `video_capture_mode:
ELECTRON_WINDOW_RECORDING_CAPTURE_MODE` to the feedback manifest. Do not use
macOS Screen Recording, `screencapture`, QuickTime, or screenshot-only videos as
the normal evidence path.

## Promotion

After the user confirms human review, run the promotion dry run first:

```bash
pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts --reviewed
```

Then apply:

```bash
pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts --reviewed --apply
```

The tool moves the spec, fixes common helper imports, creates fixture/manifest scaffolds, and updates the coverage matrix path. It does not decide request semantics.

On `--apply`, promotion treats those writes as one filesystem transaction and runs
`pnpm audit:conversation-session-coverage` against the tentative formal state. It
keeps the promotion only when the audit passes; audit failure or execution error
restores the pending spec, fixtures, manifest, and coverage matrix, then exits
nonzero. Therefore complete and validate the canonical fixture contract while the
spec is still pending instead of relying on post-promotion scaffolds.

## Fixture Contract

Use case-local data by default:

- `packages/desktop/test/e2e/fixtures/upstream/common.json` for truly shared helper responses.
- `packages/desktop/test/e2e/fixtures/upstream/<domain>/<case>.json` for case-specific provider responses.
- `packages/desktop/test/e2e/fixtures/cases/<domain>/<case>.json` for manifest metadata.
- `packages/desktop/test/e2e/fixtures/fs/<domain>/<case>/` for file-system fixtures.

Classify each request as `main`, `common`, `ignore`, or `synthetic`. Developers review uncertain classifications; tools handle mechanical checks. Do not add new case-specific responses to `provider-basic.json`.

For timing:

- `fast-text`: ordinary functional assertions.
- `controlled-stream`: stop, queue, interrupted, or running-window assertions.
- `recorded-stream`: performance or stream cadence assertions.
- `fault-stream`: socket, truncation, rate-limit, or error injection.

Every synthetic request needs a `syntheticReason` in fixture metadata and manifest requests.

## Verification

After filling fixtures:

For a pending case, validate the current spec against its canonical formal-target fixture metadata before promotion:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts
```

The `spec` field in both the case manifest and case-local provider fixture remains
`./test/e2e/conversation-session/<scenario>/<case>.test.ts` while the current spec is pending. It is the canonical formal target,
not the current physical path. Pending replay remains explicit: pass `E2E_PROVIDER_REPLAY_FIXTURE_PATH` so a normal
manual-review run still captures the live provider path.

After promotion:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/<scenario>/<case>.test.ts
```

Prove the case does not depend on legacy shared fixtures:

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case>.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/<scenario>/<case>.test.ts'
```

Then run default replay:

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/<scenario>/<case>.test.ts'
```

Before adding the case to the Docker suite, prove the formal case in isolated replay:

```bash
E2E_SPEC=./test/e2e/conversation-session/<scenario>/<case>.test.ts pnpm run test:e2e:container
```

After that passes, admit it to the Docker conversation preset:

```bash
pnpm --filter @zcode/desktop e2e:docker:admit -- --spec ./test/e2e/conversation-session/<scenario>/<case>.test.ts --verified --artifact packages/desktop/.e2e-artifacts/<run-id> --apply
pnpm run test:e2e:container:conversation
```

Docker runs are suite-oriented after admission. Use one isolated single-spec
Docker run only as the admission proof or for failure localization. Once a case
is admitted, batch stable compatible specs through the matching preset such as
`pnpm run test:e2e:container:conversation`; this reuses the image, container
startup, WDIO entrypoint, desktop app build, and agent server build. Split a case
into a separate preset or container only when it needs real capture, fault
injection, performance/timing-sensitive replay, global-state pollution, or
special network/file-system setup.

For E2E code changes, run the following required code checks once for the final change. Documentation-only edits use the documentation checks in [AGENTS.md](../../../AGENTS.md):

```bash
pnpm --filter @zcode/desktop typecheck:e2e
pnpm typecheck
pnpm lint
```

After the applicable lifecycle checks and code checks pass, finish; repeat or expand only after new edits, failures, or unresolved risks. Keep human review and promotion/admission requirements above intact. If a required environment or check is blocked, finish the executable parts and report the remaining evidence; use the root AGENTS.md completion rules and do not automatically commit incomplete verification. Report existing warnings separately from new failures.
