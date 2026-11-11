# Settings Language E2E Coverage Matrix

## Scope

Settings language coverage verifies that the General settings language selector keeps locale preference and resolved UI locale separate.

## State Dimensions

| Dimension                 | Values                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Platform locale source    | Electron `app.getPreferredSystemLanguages()` preferred list, Electron `app.getLocale()` fallback |
| User preference           | `system`, `zh-CN`, `en-US`                                                                       |
| Persisted resolved locale | `zh-CN`, `en-US`                                                                                 |
| UI surface                | Settings General section, application chrome driven by `ZCodeIntlProvider`                       |

## Accepted Cases

| Case                                                            | Setup                                                                                                                            | Action                                      | Assertions                                                                                                      | Spec                                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| SL-01 system preferred Chinese with English app locale fallback | Mock preferred languages as `["zh-Hans-CN", "en-CN"]`, mock `app.getLocale()` as `en-US`, start from explicit English preference | Select `System default` in Settings General | UI switches to Chinese, `setting.json` keeps `localePreference: "system"` and writes resolved `locale: "zh-CN"` | `packages/desktop/test/e2e/settings/general/settings-language-system-default.test.ts`           |
| SL-02 explicit language labels are autonyms                     | Current locale may be English or Chinese                                                                                         | Open language selector                      | `中文简体` and `English` remain readable in their own language                                                  | Pending behavior coverage; the source-string guard was removed during unit-test cleanup |

## Pruned Cases

| Case                                 | Reason                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Full OS language mutation during E2E | Mutating host OS language is not deterministic in CI; SL-01 uses Electron API mocks at the host boundary instead. |
| Provider replay fixtures             | Settings language selection does not call model providers, so no DeepSeek request fixture is required.            |

## Plan navigation labels

- PN-01 (formal, reviewed 2026-09-18): BigModel/Z.ai × zh-CN/en-US. In an isolated unauthenticated profile, open Model settings; assert BigModel/Z.ai and Start Plan (unchanged across locales) by their distinct navigation keys, then click each and assert its selected state and detail heading (brand vs Start Plan).
- PN-02 (formal, reviewed 2026-09-18): repeat at narrow renderer width; assert both accessible names and hover tooltip. Chinese/dark and English/light at wide and narrow widths cover presentation pairwise; no claim of phone remote transport coverage.
- Existing entitlement, payment and usage cases are pruned from this label-only change. Provider IDs, selection commands, detail brand names and persistence contracts remain unchanged.
- Spec: `packages/desktop/test/e2e/settings/providers/provider-plan-navigation-labels.test.ts`. No model request fixture is needed: this case never sends a prompt or connects an account.

### Verification (2026-09-17)

- macOS Electron: PN-01/02 four family/locale cases passed, including detail selection, wide/narrow layouts, accessible names and hover tooltips. Screenshots and results: `packages/desktop/.e2e-artifacts/desktop-e2e-20260917143155914-p51546-7a7006e045bf7287/`.
- Existing SL-01 and OAuth credential recovery passed in the same run. SL-01 now completes first-run occupation onboarding through a shared UI helper before checking locale behavior.
- Source audit found no navigation selector requiring the former BigModel/Z.ai label. Brand checks in login actions remain valid. CTP-02 had a stale connection-mode expectation (`Personal Plan` instead of the current `Individual Plan`); corrected independently of the sidebar labels.
- Targeted CTP-02 replay passed via WDIO native `--mochaOpts.grep`; report: `packages/desktop/.e2e-artifacts/desktop-e2e-20260917-143637-861/summary.md`.
- Follow-up diagnosis reproduced CTP-02B/CTP-05 on the unchanged tests: the English UI already displayed the `Team` badge and `Individual Plan` usage tab. The former assertion only accepted Chinese; the latter only accepted obsolete English wording. Both cases now run explicitly in zh-CN/en-US, assert the specific badge/tab and retain quota, model and connection persistence checks. The command-palette text at the start of the body dump was not the cause of the missing-string assertion. Full-suite transport errors after interruption are not counted as product regressions.
- CTP-02B/CTP-05 final macOS replay: all four zh-CN/en-US cases passed. Report: `packages/desktop/.e2e-artifacts/desktop-e2e-20260917-144717-306/summary.md`. Desktop E2E typecheck, workspace typecheck, lint (55 existing warnings, no errors), and architecture checks passed. These two findings are resolved; this targeted run does not claim full-suite coverage.
- At the time of this replay, the navigation cases were pending review. Promotion evidence is recorded below. Phone remote transport and Windows/Linux are not validated by these macOS renderer checks.

### Promotion (2026-09-18)

- User reviewed and approved all four PN-01/02 family/locale cases. The spec is now in the formal `settings/` directory with helper imports updated. The promotion dry run only supports conversation-session paths, so this follows the existing settings-domain migration procedure.
- Formal macOS Electron replay without `ZCODE_E2E_MANUAL_REVIEW`: **4/4 passed**. Evidence: `packages/desktop/.e2e-artifacts/desktop-e2e-20260918-010520-642/summary.json`. The first skip-build attempt stopped before tests because the existing renderer lacked the E2E store bridge; the successful run rebuilt the application and agent.
- Workspace typecheck, desktop E2E typecheck, lint (55 existing warnings, 0 errors), architecture and formatting checks passed. Product behavior and test assertions are unchanged.
- Docker verification/admission is excluded at the user's request. This macOS replay does not establish phone remote transport or Windows/Linux coverage.

### Brand naming restored (2026-09-18)

- Navigation uses BigModel/Z.ai and Start Plan in both locales again. PN-01/02 retain their formal status and now assert the restored names, including accessible labels and narrow-layout tooltips.
- Rebuilt macOS Electron replay: 4/4 passed, `packages/desktop/.e2e-artifacts/desktop-e2e-20260918-020819-008/summary.json`. Covers Chinese/dark and English/light at wide/narrow widths. Two related UI test files passed 208 assertions; typecheck, desktop E2E typecheck, lint and architecture checks passed. Real phone remote transport and Docker were not run.
