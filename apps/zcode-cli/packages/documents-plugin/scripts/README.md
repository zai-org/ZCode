# LibreOffice invocation contract

Each document plugin distributes identical copies of `zcode_libreoffice.py` and `libreoffice-profile/`. The engineering gate `node scripts/check-document-libreoffice.mjs` checks both file lists and bytes.

```sh
"$(command -v zcode-python || command -v python3)" scripts/zcode_libreoffice.py check
"$(command -v zcode-python || command -v python3)" scripts/zcode_libreoffice.py run --timeout 120 -- --convert-to pdf --outdir output input.docx
"$(command -v zcode-python || command -v python3)" scripts/zcode_libreoffice.py recalc --timeout 120 workbook.xlsx
```

The launcher requires only the Python standard library (3.9+). It finds `zcode-soffice` on PATH on every invocation, then looks for a system LibreOffice without a version minimum. It never reads an installation record or creates usage markers. The entry supplies the managed resource view and macOS backend environment.

Every probe and operation owns a fresh temporary profile. Caller arguments cannot override the profile or resource view. Recalculation disables document macros and external-link updates, calculates, saves, and requires its own success receipt. The default user profile is unchanged. Child Python bytecode writes are disabled to preserve application signatures.

Managed launch failure (including an entry removed after discovery), nonzero exit, timeout or missing receipt triggers one system attempt after cleanup. User cancellation and invalid caller parameters do not retry. The launcher reports the system version and why the managed version was unused: not ready/disabled, or runtime failure. `temporary_outputs` removes only the caller-owned outputs before each attempt.

If neither program is usable, a nonempty `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` selects desktop guidance: open Help → Preinstalled tools and let the user choose waiting, enabling the tool, or installation through setup.md. Without that flag, existing setup guidance applies. Installation is never automatic here.

```text
find PATH entry → isolated profile → invoke → cleanup
                       failure ──► one isolated system attempt → cleanup
                       cancel  ──► stop children → cleanup → propagate cancellation
```

System symlink invocation paths are preserved; resolved targets are used only for validation and backend discovery. On macOS, native system installations default to the osx backend when available. Explicit caller settings are preserved. Missing-font substitutions prefer packaged Noto fonts while keeping installed originals.

The Python API exposes `environment` and `candidate_paths` for deterministic integration tests; CLI discovery is not configurable. Format CLIs use `run_cli_operation` for awaited SIGTERM cleanup. Windows launcher-first-exit descendant ownership remains limited by taskkill; native Windows acceptance is tracked separately.

Current specifications: [LibreOffice](../../../../../docs/preinstalled-tools/libreoffice.md) and [generic preinstallation](../../../../../docs/preinstalled-tools/README.md).
