# LibreOffice installation in a non-managed environment

Use this guide when the unified launcher finds no usable installation and installation is chosen. The launcher discovers the preinstalled entry on PATH; desktop availability only selects the installation guidance.
On desktop (`ZCODE_PREINSTALLED_TOOLS_AVAILABLE` is set), report the unavailable preparation state and its reason, then ask the user to wait or let the Agent install. Keep existing files. After installation, use the unified launcher rather than soffice directly.


Any step that calls `libreoffice`/`soffice` (`.doc` → `.docx`, DOCX → PDF, visual verification)
depends on LibreOffice.

**If LibreOffice is not installed, you MUST install it. This is not a choice.**

**FORBIDDEN — do not do any of these:**
- ❌ Using Microsoft Word, WPS Office, Pages, or any other program already on the user's machine
  *instead of* installing LibreOffice.
- ❌ Deciding on the user's behalf that the download is "too large", "too slow", or "not worth it".
  **The package being large is NOT a reason to skip the install.** It is expected to be large.
- ❌ Asking the user "should I use Word instead to save time?" — that is the same violation dressed
  up as a question. Do not offer the substitution.
- ❌ Silently degrading (skipping the PDF check, skipping visual verification) to avoid installing.

**REQUIRED sequence — no steps skipped, in this order:**

1. **Explain the necessity to the user.** LibreOffice is the conversion engine that preserves the
   document's styles, layout, fonts, and page breaks faithfully — no other tool reproduces the same
   output, so substituting it degrades fidelity.
2. **Tell them the download is large** (roughly several hundred MB) and may take a while. This is
   information for the user, **not** a decision point for you — state it and proceed to install.
3. **Install it now.** **Preferred source — Tsinghua TUNA mirror** (fast in China, current build):
   `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/` — pick the
   subdirectory for the platform/arch (`deb/x86_64`, `deb/aarch64`, `rpm/x86_64`, `mac/aarch64`,
   `mac/x86_64`, `win/x86_64`, `win/aarch64`) and download the main package from it. If 26.8.0 is no
   longer there, list `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/` and take
   the newest version. Full per-platform download-and-install commands: `env_setup/setup.md` →
   *"LibreOffice — Recommended Download Source"*.
   Package-manager fallback, only if the mirror is unreachable:
   - macOS: `brew install --cask libreoffice`
   - Linux (Debian/Ubuntu): `sudo apt install libreoffice-core`
   - Windows: `winget install TheDocumentFoundation.LibreOffice`
4. **Register the binary on `PATH`, then re-verify.** An install that leaves `soffice` off the
   executable search path looks identical to "not installed" on the next probe — that is what causes
   the same several-hundred-MB package to be downloaded twice. **The mechanism differs per OS**
   (Linux/macOS: symlink into `/usr/local/bin`; Windows: append the program dir to the user `PATH`
   with `setx`). Full per-OS commands: `env_setup/setup.md` → *"Register the binary on PATH"*.
   Re-run `"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check` and only continue once it prints a version. Corollary: **probe before
   installing** — if the binary already exists on disk but off-`PATH`, register it instead of
   reinstalling.
5. **Only after that install has actually been attempted AND failed** may you use software already
   on the user's machine (Word, WPS, Pages). Report the install failure and what you switched to,
   and warn that output fidelity may differ.

> **The gate is simple: no install attempt = no substitute program.** If you have not run the
> install command and seen it fail, using Word/WPS/Pages/Keynote is a violation of this skill.
