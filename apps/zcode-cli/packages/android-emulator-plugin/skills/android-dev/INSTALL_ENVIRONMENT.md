# Android Environment Setup

Use `android_preflight` to check adb and `android_list_devices` to list devices.
An installed SDK adb outside the workspace can also be used through Shell; MCP
is optional. Missing SDK tools must be installed through the steps below, never
replaced with a workspace executable or interpreter/script workaround.

Use this procedure only when `android_preflight` reports that the Android development environment is not ready.

The goal is to make the environment ready with deterministic shell commands, then return to MCP tools. Do not call removed setup tools such as `android_ensure_environment`.

## Configurable Defaults

The plugin manifest exposes the Android SDK path, default AVD, JDK major version,
Android API level, build-tools version, and system image variant/ABI as user
config. ZCode/OpenCLI passes those values to the MCP server as `ANDROID_PLUGIN_*`
environment variables, and `android_preflight` reports the effective defaults.

Use those configured values instead of inventing versions. The documented fallback defaults are:

- `ANDROID_PLUGIN_JDK_MAJOR=17`
- `ANDROID_PLUGIN_API_LEVEL=35`
- `ANDROID_PLUGIN_BUILD_TOOLS_VERSION=35.0.0`
- `ANDROID_PLUGIN_SYSTEM_IMAGE_VARIANT=default`
- `ANDROID_PLUGIN_SYSTEM_IMAGE_ABI=` for host-based auto selection

The Windows PowerShell setup commands also accept these shell environment
overrides when you run them directly; they are not plugin user config and are
not injected into the MCP server:

- `ANDROID_PLUGIN_DEFAULT_PROFILE=medium_phone`
- `ANDROID_PLUGIN_WINDOWS_JDK_WINGET_PACKAGE=EclipseAdoptium.Temurin.17.JDK`

## Guardrails

- Use explicit long timeouts for install commands, normally 10-30 minutes.
- Do not run `brew`, `sdkmanager`, `avdmanager`, or PowerShell installers in the background.
- Do not pipe long installer output through `tail` only; preserve logs when useful.
- If a command asks for a password, administrator permission, or license acceptance, stop and ask the user to complete or approve that step.
- After each setup phase, re-run `android_preflight` and continue from the latest result.

## Quick Fix: Gradle Not Found

If `android_preflight` only reports `Gradle` as `not found`, do not reinstall the Android SDK. Install Gradle, then re-run `android_preflight`.

macOS:

```bash
brew list gradle >/dev/null 2>&1 || brew install gradle
gradle -v
```

Windows PowerShell:

```powershell
winget install --id Gradle.Gradle --exact --source winget --accept-source-agreements --accept-package-agreements --silent
gradle -v
```

If a project already has `gradlew` or `gradlew.bat`, global Gradle is not required for that project. Generated projects initially need global Gradle so `android_build_app` can create the wrapper.

## macOS

### Detect Current State

```bash
JDK_MAJOR="${ANDROID_PLUGIN_JDK_MAJOR:-17}"
uname -s
command -v brew || true
/usr/libexec/java_home -V 2>&1 || true
test -x "/opt/homebrew/opt/openjdk@$JDK_MAJOR/libexec/openjdk.jdk/Contents/Home/bin/java" && "/opt/homebrew/opt/openjdk@$JDK_MAJOR/libexec/openjdk.jdk/Contents/Home/bin/java" -version
command -v gradle || true
command -v sdkmanager || true
command -v emulator || true
echo "ANDROID_HOME=$ANDROID_HOME"
echo "ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT"
```

### Install JDK

Prefer the Homebrew formula. It is more reliable for headless setup than the JDK cask, and the plugin can inject its `JAVA_HOME` into child processes.

Homebrew `openjdk@<major>` is keg-only. That means `java` and `/usr/libexec/java_home` may still fail until `JAVA_HOME`/`PATH` are set, or until the optional system symlink is created.

```bash
JDK_MAJOR="${ANDROID_PLUGIN_JDK_MAJOR:-17}"
brew list "openjdk@$JDK_MAJOR" >/dev/null 2>&1 || brew install "openjdk@$JDK_MAJOR"
export JAVA_HOME="/opt/homebrew/opt/openjdk@$JDK_MAJOR/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:/opt/homebrew/bin:$PATH"
java -version
```

If the user wants Java visible to `/usr/libexec/java_home`, ask before running the privileged symlink:

```bash
JDK_MAJOR="${ANDROID_PLUGIN_JDK_MAJOR:-17}"
sudo ln -sfn "/opt/homebrew/opt/openjdk@$JDK_MAJOR/libexec/openjdk.jdk" "/Library/Java/JavaVirtualMachines/openjdk-$JDK_MAJOR.jdk"
```

Only write shell startup files after user confirmation:

```bash
JDK_MAJOR="${ANDROID_PLUGIN_JDK_MAJOR:-17}"
printf '\nexport JAVA_HOME=/opt/homebrew/opt/openjdk@%s/libexec/openjdk.jdk/Contents/Home\nexport PATH="$JAVA_HOME/bin:$PATH"\n' "$JDK_MAJOR" >> ~/.zshrc
```

### Install Gradle

Generated projects prefer `./gradlew`. If it is missing, `android_build_app` can generate a wrapper when `gradle` is available.

```bash
brew list gradle >/dev/null 2>&1 || brew install gradle
```

### Install Android Command-Line Tools

```bash
brew list --cask android-commandlinetools >/dev/null 2>&1 || brew install --cask android-commandlinetools
```

Use the plugin SDK path if configured; otherwise use the Homebrew cask location:

```bash
JDK_MAJOR="${ANDROID_PLUGIN_JDK_MAJOR:-17}"
export ANDROID_HOME="${ANDROID_PLUGIN_SDK_PATH:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="/opt/homebrew/opt/openjdk@$JDK_MAJOR/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:/opt/homebrew/bin:$PATH"
sdkmanager --version
```

### Install SDK Packages

Default to the smaller `default` system image. Use `google_apis` only when the app needs Google APIs.

Image variants trade size for capabilities:

- `default`: smaller, enough for normal build/run testing.
- `google_apis`: larger, use when Google APIs are required.
- `google_apis_playstore`: largest, use only when Play Store services are required.

```bash
ANDROID_API_LEVEL="${ANDROID_PLUGIN_API_LEVEL:-35}"
ANDROID_BUILD_TOOLS_VERSION="${ANDROID_PLUGIN_BUILD_TOOLS_VERSION:-35.0.0}"
SYSTEM_IMAGE_VARIANT="${ANDROID_PLUGIN_SYSTEM_IMAGE_VARIANT:-default}"
if [ -n "${ANDROID_PLUGIN_SYSTEM_IMAGE_ABI:-}" ]; then
  SYSTEM_IMAGE_ABI="$ANDROID_PLUGIN_SYSTEM_IMAGE_ABI"
elif [ "$(uname -m)" = "arm64" ]; then
  SYSTEM_IMAGE_ABI="arm64-v8a"
else
  SYSTEM_IMAGE_ABI="x86_64"
fi
SYSTEM_IMAGE="system-images;android-$ANDROID_API_LEVEL;$SYSTEM_IMAGE_VARIANT;$SYSTEM_IMAGE_ABI"

sdkmanager --sdk_root="$ANDROID_HOME" --install \
  "cmdline-tools;latest" \
  "platform-tools" \
  "emulator" \
  "platforms;android-$ANDROID_API_LEVEL" \
  "build-tools;$ANDROID_BUILD_TOOLS_VERSION" \
  "$SYSTEM_IMAGE"
```

If the system image download times out, retry the exact command with a longer timeout and keep the output log. Avoid launching a second `sdkmanager` for the same package while the first one is still running.

If SDK licenses block installation, ask the user to approve license handling before running:

```bash
sdkmanager --sdk_root="$ANDROID_HOME" --licenses
```

### Create AVD

Only create an AVD when no ready USB device is available and the user needs a
new emulator target.

```bash
AVD_NAME="${ANDROID_PLUGIN_DEFAULT_AVD:-medium_phone}"
DEVICE_PROFILE="${ANDROID_PLUGIN_DEFAULT_PROFILE:-medium_phone}"

avdmanager create avd \
  --name "$AVD_NAME" \
  --package "$SYSTEM_IMAGE" \
  --device "$DEVICE_PROFILE"
```

If the AVD already exists, do not delete it unless the user explicitly confirms.

## Windows PowerShell

Run these commands step by step. They install the configured JDK and Android
Studio with `winget`, then use the Android SDK tools that Android Studio
installs. Keep the setup visible for review.

### Detect Current State

```powershell
$PSVersionTable.PSVersion
where.exe java 2>$null
where.exe gradle 2>$null
where.exe sdkmanager 2>$null
where.exe emulator 2>$null
Write-Output "ANDROID_HOME=$env:ANDROID_HOME"
Write-Output "ANDROID_SDK_ROOT=$env:ANDROID_SDK_ROOT"
```

### Install JDK, Gradle, and Android Studio

```powershell
$JdkPackage = if ($env:ANDROID_PLUGIN_WINDOWS_JDK_WINGET_PACKAGE) { $env:ANDROID_PLUGIN_WINDOWS_JDK_WINGET_PACKAGE } else { "EclipseAdoptium.Temurin.17.JDK" }
winget install --id "$JdkPackage" --exact --source winget --accept-source-agreements --accept-package-agreements --silent
winget install --id Gradle.Gradle --exact --source winget --accept-source-agreements --accept-package-agreements --silent
winget install --id Google.AndroidStudio --exact --source winget --accept-source-agreements --accept-package-agreements
```

### Confirm Android Command-Line Tools

Use Android Studio SDK Manager to install Android SDK Command-line Tools,
Android SDK Platform-Tools, Android Emulator, the configured Android platform,
build tools, and a system image. Avoid direct zip URLs here so the guide does
not need to maintain Google command-line tools package identifiers.

```powershell
$SdkRoot = if ($env:ANDROID_PLUGIN_SDK_PATH) { $env:ANDROID_PLUGIN_SDK_PATH } else { "$env:LOCALAPPDATA\Android\Sdk" }
$SdkManager = Join-Path $SdkRoot "cmdline-tools\latest\bin\sdkmanager.bat"
if (-not (Test-Path $SdkManager)) {
  throw "Install Android SDK Command-line Tools from Android Studio SDK Manager, then rerun android_preflight."
}
```

Configure the current session:

```powershell
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$JdkMajor = if ($env:ANDROID_PLUGIN_JDK_MAJOR) { $env:ANDROID_PLUGIN_JDK_MAJOR } else { "17" }
$JavaHome = Get-ChildItem "$env:ProgramFiles\Eclipse Adoptium" -Directory -Filter "jdk-$JdkMajor*" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$env:JAVA_HOME = $JavaHome.FullName
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:Path"
```

Persist user-level environment variables when the user wants future terminals to inherit them:

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_HOME", $env:ANDROID_HOME, "User")
[Environment]::SetEnvironmentVariable("ANDROID_SDK_ROOT", $env:ANDROID_HOME, "User")
[Environment]::SetEnvironmentVariable("JAVA_HOME", $env:JAVA_HOME, "User")
```

Install SDK packages:

Default to the smaller `default` system image.

```powershell
$AndroidApiLevel = if ($env:ANDROID_PLUGIN_API_LEVEL) { $env:ANDROID_PLUGIN_API_LEVEL } else { "35" }
$BuildToolsVersion = if ($env:ANDROID_PLUGIN_BUILD_TOOLS_VERSION) { $env:ANDROID_PLUGIN_BUILD_TOOLS_VERSION } else { "35.0.0" }
$SystemImageVariant = if ($env:ANDROID_PLUGIN_SYSTEM_IMAGE_VARIANT) { $env:ANDROID_PLUGIN_SYSTEM_IMAGE_VARIANT } else { "default" }
$Abi = if ($env:ANDROID_PLUGIN_SYSTEM_IMAGE_ABI) { $env:ANDROID_PLUGIN_SYSTEM_IMAGE_ABI } elseif ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64-v8a" } else { "x86_64" }
$SystemImage = "system-images;android-$AndroidApiLevel;$SystemImageVariant;$Abi"

sdkmanager.bat --sdk_root="$env:ANDROID_HOME" --install `
  "cmdline-tools;latest" `
  "platform-tools" `
  "emulator" `
  "platforms;android-$AndroidApiLevel" `
  "build-tools;$BuildToolsVersion" `
  "$SystemImage"
```

If SDK licenses block installation, ask the user to approve license handling before running:

```powershell
sdkmanager.bat --sdk_root="$env:ANDROID_HOME" --licenses
```

Create an AVD:

Only create an AVD when no ready USB device is available and the user needs a
new emulator target.

```powershell
$AvdName = if ($env:ANDROID_PLUGIN_DEFAULT_AVD) { $env:ANDROID_PLUGIN_DEFAULT_AVD } else { "medium_phone" }
$DeviceProfile = if ($env:ANDROID_PLUGIN_DEFAULT_PROFILE) { $env:ANDROID_PLUGIN_DEFAULT_PROFILE } else { "medium_phone" }

avdmanager.bat create avd `
  --name "$AvdName" `
  --package "$SystemImage" `
  --device "$DeviceProfile"
```

### Windows Emulator Acceleration

The command-line flow can install the SDK and create an AVD, but Windows emulator acceleration may still require user or administrator action.

Check acceleration:

```powershell
emulator.exe -accel-check
```

If acceleration or drivers are missing:

- Ask the user to enable CPU virtualization in BIOS/UEFI if it is disabled.
- Prefer enabling Windows Hypervisor Platform / WHPX when available.
- If the emulator driver still needs setup, install Android Studio and ask the user to finish Device Manager or driver prompts:

```powershell
winget install --id Google.AndroidStudio --exact --source winget --accept-source-agreements --accept-package-agreements
```

## Project Configuration

Generated projects include `gradle.properties` and create `local.properties` when the plugin can detect the SDK root. If you need to repair an existing Android Gradle root manually:

Create `gradle.properties` when AndroidX or Compose dependencies are present:

```properties
android.useAndroidX=true
android.nonTransitiveRClass=true
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
```

macOS:

```bash
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > local.properties
```

Windows PowerShell:

```powershell
$SdkDir = $env:ANDROID_HOME -replace '\\', '/'
"sdk.dir=$SdkDir" | Set-Content local.properties
```

If the Gradle wrapper is missing and Gradle is installed:

macOS:

```bash
gradle wrapper --gradle-version 8.9
```

Windows PowerShell:

```powershell
gradle wrapper --gradle-version 8.9
```

## Final Verification

Re-run `android_preflight`. Continue when the host OS, SDK root, `adb`,
`sdkmanager`, Java, Gradle, and at least one Android target path are ready. A
ready USB device satisfies target readiness without an AVD. For emulator
workflows, also require `emulator`, `avdmanager`, at least one AVD, and on
Windows a passing `Emulator acceleration` check before starting the emulator. It
is acceptable for `ADB devices` to show zero devices before an emulator is
started.
