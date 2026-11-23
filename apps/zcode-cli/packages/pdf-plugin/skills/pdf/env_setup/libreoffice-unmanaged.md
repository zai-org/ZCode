# LibreOffice installation in a non-managed environment

Use this guide when the unified launcher finds no usable installation and installation is chosen. The launcher discovers the preinstalled entry on PATH; desktop availability only selects the installation guidance.

**LibreOffice (Office→PDF) is different — you MUST install it, not substitute it.** Using Word,
WPS, Keynote or Pages *instead of* installing is forbidden, and a large download is **not** a reason
to skip it. Required: explain the necessity to the user (only engine that preserves
themes/layouts/master slides faithfully), say the package is large, then install it — **preferred
source is the Tsinghua TUNA mirror**
`https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/` (pick the
platform/arch subdirectory; if that version is gone, take the newest under
`.../libreoffice/stable/`), with `brew install --cask libreoffice` /
`sudo apt install libreoffice-core` / `winget install TheDocumentFoundation.LibreOffice` as
fallbacks. **Then register the binary on `PATH` and re-verify `"$(command -v zcode-python || command -v python3)" "$PDF_SKILL_DIR/../../scripts/zcode_libreoffice.py" check`** — an install
left off the executable search path reads as "not installed" to the next probe and causes a
redundant multi-hundred-MB reinstall; the mechanism differs per OS (Linux/macOS symlink into
`/usr/local/bin`, Windows `setx` the program dir onto the user `PATH`). So **probe before
installing**: a binary already on disk but off-`PATH` needs registering, not reinstalling.
Another program is permitted **only after** an
install attempt has actually failed. **No install attempt = no substitute program.**
See `briefs/process.md` and `env_setup/setup.md` (→ *"Register the binary on PATH"*) for the full
procedure.

Full platform instructions: [setup.md](setup.md#libreoffice--recommended-download-source-tsinghua-tuna-mirror).
