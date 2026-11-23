# LibreOffice installation in a non-managed environment

Use this guide when the unified launcher finds no usable installation and installation is chosen. The launcher discovers the preinstalled entry on PATH; desktop availability only selects the installation guidance.
On desktop (`ZCODE_PREINSTALLED_TOOLS_AVAILABLE` is set), report the unavailable preparation state and its reason, then ask the user to wait or let the Agent install. Keep existing files. After installation, use the unified launcher rather than soffice directly.


Every PPTX → PDF conversion and every rendered preview/thumbnail step depends on LibreOffice.

**If LibreOffice is not installed, you MUST install it. This is not a choice.**

**FORBIDDEN — do not do any of these:**
- ❌ Using Keynote, Microsoft PowerPoint, WPS Office, or any other program already on the user's
  machine *instead of* installing LibreOffice.
- ❌ Deciding on the user's behalf that the download is "too large", "too slow", or "not worth it".
  **The package being large is NOT a reason to skip the install.** It is expected to be large.
- ❌ Asking the user "should I use Keynote/PowerPoint instead to save time?" — that is the same
  violation dressed up as a question. Do not offer the substitution.
- ❌ Silently degrading (shipping the deck without the render check) to avoid installing.

**REQUIRED sequence — no steps skipped, in this order:**

1. **Explain the necessity to the user.** LibreOffice is what renders the deck's real layout —
   master slides, themes, placeholder geometry — so it is the only way to verify slides actually
   fit before delivery. Substituting it means shipping an unverified deck.
2. **Tell them the download is large** (roughly several hundred MB) and may take a while. This is
   information for the user, **not** a decision point for you — state it and proceed to install.
3. **Install it now.** **Preferred source — Tsinghua TUNA mirror** (fast in China, current build):
   `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/`. Pick the
   subdirectory matching the OS and CPU arch (`uname -m` / `$env:PROCESSOR_ARCHITECTURE`) and
   download the main package from it:

   | Platform | Path | Main package |
   |----------|------|--------------|
   | Linux x86_64 (deb) | `deb/x86_64/` | `LibreOffice_26.8.0_Linux_x86-64_deb.tar.gz` |
   | Linux ARM64 (deb) | `deb/aarch64/` | `LibreOffice_26.8.0_Linux_aarch64_deb.tar.gz` |
   | Linux x86_64 (rpm) | `rpm/x86_64/` | `LibreOffice_26.8.0_Linux_x86-64_rpm.tar.gz` |
   | macOS Apple Silicon | `mac/aarch64/` | `LibreOffice_26.8.0_MacOS_aarch64.dmg` |
   | macOS Intel | `mac/x86_64/` | `LibreOffice_26.8.0_MacOS_x86-64.dmg` |
   | Windows x64 | `win/x86_64/` | `LibreOffice_26.8.0_Win_x86-64.msi` |
   | Windows ARM64 | `win/aarch64/` | `LibreOffice_26.8.0_Win_aarch64.msi` |

   Linux (deb): `tar -xzf <pkg>.tar.gz && sudo dpkg -i LibreOffice_26.8.0*/DEBS/*.deb && sudo apt-get install -f -y`
   macOS: `hdiutil attach <pkg>.dmg && cp -R /Volumes/LibreOffice/LibreOffice.app /Applications/ && hdiutil detach /Volumes/LibreOffice`
   Windows: `msiexec /i <pkg>.msi /qn` (needs admin). Verify in PowerShell:

   ```powershell
   $PY = Get-Command zcode-python -ErrorAction SilentlyContinue
   if (-not $PY) { $PY = Get-Command python3, python, py -ErrorAction SilentlyContinue | Select-Object -First 1 }
   & $PY.Source "$env:PPTX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check
   ```

   **If 26.8.0 is gone** (the mirror keeps only a few releases), list
   `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/` and use the newest version
   directory, substituting that version number above.

   Package-manager fallback, only if the mirror is unreachable:
   - macOS: `brew install --cask libreoffice`
   - Linux (Debian/Ubuntu): `sudo apt-get install libreoffice`
   - Windows: `winget install TheDocumentFoundation.LibreOffice`
4. **Register the binary on `PATH`, then re-verify.** Do this as part of the install, not as an
   afterthought: an install that leaves `soffice` off the executable search path is
   indistinguishable from "not installed" to the next `command -v soffice` probe — which re-triggers
   this whole block and makes you download several hundred MB you already have. **The mechanism
   differs per OS — use the one for the platform you are on:**

   | Platform | Register it | Then verify |
   |----------|-------------|-------------|
   | Linux | `sudo ln -sf /opt/libreoffice*/program/soffice /usr/local/bin/soffice` | `"$(command -v zcode-python \|\| command -v python3)" "$PPTX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check` |
   | macOS | `sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /usr/local/bin/soffice` | `"$(command -v zcode-python \|\| command -v python3)" "$PPTX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check` |
   | Windows | `setx PATH "$([Environment]::GetEnvironmentVariable('PATH','User'));C:\Program Files\LibreOffice\program"` | `& $PY.Source "$env:PPTX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check` (`$PY` as selected in step 3) |

   Notes: on Apple Silicon `/usr/local/bin` is not always on `PATH` — if the verify still fails, link
   into `/opt/homebrew/bin` instead. On Windows `setx` only affects **newly launched** shells, so for
   the rest of the current session call `soffice.exe` by its full path. Only continue once the verify
   prints a version. Corollary: **probe before installing** — if the binary already exists on disk
   but off-`PATH` (check `/opt/libreoffice*/program/soffice`,
   `/Applications/LibreOffice.app/Contents/MacOS/soffice`,
   `C:\Program Files\LibreOffice\program\soffice.exe`), register it instead of reinstalling.
5. **Only after that install has actually been attempted AND failed** may you use software already
   on the user's machine (Keynote, PowerPoint, WPS). Report the install failure and what you
   switched to, and warn that the rendering may differ from this skill's normal checks.

> **The gate is simple: no install attempt = no substitute program.** If you have not run the
> install command and seen it fail, using Keynote/PowerPoint/WPS is a violation of this skill.

---
