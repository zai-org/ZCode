import childProcess from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POWERSHELL_COMMON_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

const WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP = [
  // 首次模块导入会向 stderr 写进度 CLIXML；只静默进度，实际错误仍须拒绝更新。
  "$ProgressPreference='SilentlyContinue';",
  "$ErrorActionPreference='Stop';",
  "try{",
  "$zcodeSecurityModule=[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1');",
  "Import-Module -Name $zcodeSecurityModule -Force -ErrorAction Stop;",
  "}catch{",
  "[Console]::Error.WriteLine(('Windows PowerShell Security module load failed: {0}' -f $_.Exception.Message));",
  "exit 26;",
  "};",
].join("");

function encodeUtf8Value(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function createEncodedPowerShellArgs(script, values = []) {
  // Windows PowerShell 5.1 会把普通 `-Command` 后续 argv 拼回命令文本，
  // 不会把它们注入 `$args`。动态值先单独编码，再放进 `-EncodedCommand`，同时避免
  // Program Files 空格、引号或分号被 PowerShell 二次解析成脚本内容。
  const valueBindings = values
    .map(
      (value, index) =>
        `$zcodeArg${index}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeUtf8Value(value)}'));`,
    )
    .join("");
  const encodedCommand = Buffer.from(`${valueBindings}${script}`, "utf16le").toString("base64");
  return [...POWERSHELL_COMMON_ARGS, "-EncodedCommand", encodedCommand];
}

export function escapePowerShellLiteral(value) {
  // PowerShell 将排版单引号也视为定界符，必须与 ASCII 单引号一样双写，防止路径变成代码。
  if (/[\0\r\n]/u.test(value)) {
    throw new Error("PowerShell path literal cannot contain NUL or newline characters");
  }
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

export function createWindowsPowerShellSecurityArgs(script, values = []) {
  // 由 pwsh 启动的 Node 会继承 PowerShell 7 的 PSModulePath，随后再启动
  // Windows PowerShell 5.1 时可能错误发现不兼容的 Security 模块。直接从当前
  // powershell.exe 的 PSHOME 显式加载系统模块，避免把外部环境变量当作模块信任根。
  return createEncodedPowerShellArgs(`${WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP}${script}`, values);
}

export async function readWindowsAuthenticodeSignature(filePath) {
  const pathLiteral = escapePowerShellLiteral(filePath);
  const outputDir = await mkdtemp(join(tmpdir(), "zcode-signature-"));
  try {
    const outputPath = join(outputDir, "signature.json");
    // 受限语言模式会禁止路径解码和 Console 编码的 .NET 调用；专用查询只用 cmdlet，
    // 结果写入独立 UTF-8 文件，既保留中文签名者，也不改变其他 PowerShell 消费者。
    const script = [
      `$zcodeArg0=${pathLiteral};`,
      `$zcodeSignatureOutput=${escapePowerShellLiteral(outputPath)};`,
      "$ProgressPreference='SilentlyContinue';",
      "$ErrorActionPreference='Stop';",
      "try{",
      "$securityModule=Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1';",
      "Import-Module -Name $securityModule -Force -ErrorAction Stop;",
      "$signature=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg0;",
      "@{status=[int]$signature.Status;subject=$signature.SignerCertificate.Subject}|ConvertTo-Json -Compress|Out-File -LiteralPath $zcodeSignatureOutput -Encoding utf8 -NoNewline;",
      "}catch{Write-Error ('Windows Authenticode query failed: ' + $_.Exception.Message) -ErrorAction Continue;exit 27};",
    ].join("");

    await new Promise((resolve, reject) => {
      childProcess.execFile(
        "powershell.exe",
        createEncodedPowerShellArgs(script),
        { encoding: "utf8", timeout: 30_000, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error) reject(error);
          else if (stderr) reject(new Error(stderr));
          else resolve();
        },
      );
    });
    const output = await readFile(outputPath, "utf8");
    return JSON.parse(output.replace(/^\uFEFF/u, "").trim());
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

export async function verifyWindowsAuthenticodeSignature(filePath) {
  const signature = await readWindowsAuthenticodeSignature(filePath);
  // 官方 HTTPS 清单与文件哈希决定发布授权；这里只检查 Windows 签名有效性。
  // 不固定证书 DN，避免换证后长期未升级的客户端只能依赖过渡版本。
  if (
    signature.status !== 0 ||
    typeof signature.subject !== "string" ||
    !signature.subject.trim()
  ) {
    return "Windows update requires a valid Authenticode signature";
  }
  return null;
}
