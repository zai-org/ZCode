import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  verifyWindowsAuthenticodeSignature,
  createEncodedPowerShellArgs,
  createWindowsPowerShellSecurityArgs,
  escapePowerShellLiteral,
} from "../scripts/powershell-command.mjs";

function decodeCommand(args: string[]): string {
  expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  expect(args).toHaveLength(5);
  return Buffer.from(args[4]!, "base64").toString("utf16le");
}

describe("powershell-command", () => {
  it.each([
    ["a'b", "'a''b'"],
    ["a‘b", "'a‘‘b'"],
    ["a’b", "'a’’b'"],
    ["a‚b", "'a‚‚b'"],
    ["a‛b", "'a‛‛b'"],
  ])("PowerShell 路径字面量安全转义 %j", (value, expected) => {
    expect(escapePowerShellLiteral(value)).toBe(expected);
  });

  it.each(["a\u0000b", "a\nb", "a\rb"])("拒绝 PowerShell 路径控制符 %j", (value) => {
    expect(() => escapePowerShellLiteral(value)).toThrow("NUL or newline");
  });

  it("把动态值编码进脚本且不再依赖普通 -Command 的尾随参数", () => {
    const values = ["C:\\Program Files\\Z'Code;测试\\helper.exe", "value with spaces & symbols"];
    const args = createEncodedPowerShellArgs(
      "[Console]::Out.Write($zcodeArg0 + '|' + $zcodeArg1)",
      values,
    );

    const command = decodeCommand(args);
    expect(command).not.toContain("$args");
    for (const [index, value] of values.entries()) {
      expect(command).not.toContain(value);
      expect(command).toContain(`$zcodeArg${index}=`);
      expect(command).toContain(Buffer.from(value, "utf8").toString("base64"));
    }
  });

  it("从 PSHOME 显式加载 Windows PowerShell Security 模块", () => {
    const command = decodeCommand(
      createWindowsPowerShellSecurityArgs("[Console]::Out.Write('loaded')"),
    );

    expect(command).toContain(
      "[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security'",
    );
    expect(command).toContain("Import-Module -Name $zcodeSecurityModule -Force -ErrorAction Stop");
    expect(command).toContain("Windows PowerShell Security module load failed");
    expect(command).toContain("exit 26");
    expect(command).not.toContain("$env:PSModulePath");
    expect(command).toContain("$ProgressPreference='SilentlyContinue';");
    expect(command.indexOf("$ProgressPreference='SilentlyContinue'")).toBeLessThan(
      command.indexOf("Import-Module"),
    );
  });

  it.runIf(process.platform === "win32")(
    "Windows PowerShell 能还原带空格和脚本元字符的动态值",
    () => {
      const values = ["C:\\Program Files\\Z'Code;测试\\helper.exe", "value with spaces & symbols"];
      const output = execFileSync(
        "powershell.exe",
        createEncodedPowerShellArgs(
          "[Console]::Out.Write($zcodeArg0 + [Environment]::NewLine + $zcodeArg1)",
          values,
        ),
        { encoding: "utf8" },
      );

      expect(output.split(/\r?\n/)).toEqual(values);
    },
  );

  it.runIf(process.platform === "win32")(
    "Windows PowerShell 在 PSModulePath 被污染时仍加载系统 Security 模块",
    () => {
      const output = execFileSync(
        "powershell.exe",
        createWindowsPowerShellSecurityArgs(
          [
            "$signature=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg0;",
            "[Console]::Out.Write($null -ne $signature)",
          ].join(""),
          [process.execPath],
        ),
        {
          encoding: "utf8",
          env: { ...process.env, PSModulePath: "Z:\\zcode-invalid-psmodulepath" },
        },
      );

      expect(output).toBe("True");
    },
  );
});

// 工程适配器回归：只替换系统进程，仍执行真实临时文件读取与清理。
function mockSignatureQuery(
  result: unknown,
  options: { stderr?: string; error?: Error; output?: string } = {},
) {
  return vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
    const command = decodeCommand(args[1] as string[]);
    const output = command
      .match(
        /\$zcodeSignatureOutput='((?:[^'\u2018\u2019\u201A\u201B]|(['\u2018\u2019\u201A\u201B])\2)*)';/,
      )?.[1]
      ?.replace(/(['\u2018\u2019\u201A\u201B])\1/g, "$1");
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    if (options.error) {
      callback(options.error, "", "");
    } else if (output && options.output !== "missing") {
      void writeFile(output, options.output ?? `\uFEFF${JSON.stringify(result)}`, "utf8").then(
        () => callback(null, "", options.stderr ?? ""),
        (error) => callback(error, "", ""),
      );
    } else {
      callback(null, "", options.stderr ?? "");
    }
    return {} as childProcess.ChildProcess;
  });
}

describe("Windows Authenticode 有效性校验", () => {
  it.runIf(process.platform === "win32")(
    "原生签名查询不会把首次模块加载进度误判为错误",
    async () => {
      const file = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      expect(await verifyWindowsAuthenticodeSignature(file)).toBeNull();
    },
  );

  it.each(["CN=Original Publisher, O=Original, C=US", "CN=换发证书, O=测试公司, C=CN"])(
    "有效签名不受发布者 DN 限制：%s",
    async (subject) => {
      const spy = mockSignatureQuery({ status: 0, subject });
      try {
        expect(
          await verifyWindowsAuthenticodeSignature("C:\\Program Files\\Example';&.exe"),
        ).toBeNull();
        const command = decodeCommand(spy.mock.calls[0]![1] as string[]);
        expect(command).toContain("Get-AuthenticodeSignature -LiteralPath $zcodeArg0");
        expect(command).toContain("Example'';&.exe");
        expect(command).not.toMatch(/\[(?:Console|Convert|Text\.|IO\.)/);
        const output = command
          .match(
            /\$zcodeSignatureOutput='((?:[^'\u2018\u2019\u201A\u201B]|(['\u2018\u2019\u201A\u201B])\2)*)';/,
          )![1]!
          .replace(/''/g, "'");
        await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([
    { status: 2, subject: "CN=Unsigned" },
    { status: 1, subject: "CN=Tampered" },
    { status: 0, subject: "" },
    { status: "0", subject: "CN=Malformed" },
  ])("拒绝无效签名或畸形结果：%j", async (result) => {
    const spy = mockSignatureQuery(result);
    try {
      expect(await verifyWindowsAuthenticodeSignature("C:\\example.exe")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { error: new Error("PowerShell unavailable") },
    { error: Object.assign(new Error("PowerShell timed out"), { killed: true }) },
    { stderr: "actual module error" },
    { output: "missing" },
    { output: "not JSON" },
  ])("系统查询、超时或输出失败不放行：%j", async (options) => {
    const spy = mockSignatureQuery({ status: 0, subject: "CN=Example" }, options);
    try {
      await expect(verifyWindowsAuthenticodeSignature("C:\\example.exe")).rejects.toThrow();
      const command = decodeCommand(spy.mock.calls[0]![1] as string[]);
      const output = command
        .match(
          /\$zcodeSignatureOutput='((?:[^'\u2018\u2019\u201A\u201B]|(['\u2018\u2019\u201A\u201B])\2)*)';/,
        )![1]!
        .replace(/''/g, "'");
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      spy.mockRestore();
    }
  });

  it.runIf(process.platform === "win32").each(["FullLanguage", "ConstrainedLanguage"])(
    "%s 下真实查询保留安全边界和特殊字符路径",
    async (mode) => {
      const original = childProcess.execFile;
      const spy = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
        const command = decodeCommand(args[1] as string[]);
        const encoded = Buffer.from(
          `$ExecutionContext.SessionState.LanguageMode='${mode}';${command}`,
          "utf16le",
        ).toString("base64");
        return Reflect.apply(original, childProcess, [
          args[0],
          [...(args[1] as string[]).slice(0, -1), encoded],
          { ...(args[2] as object), env: { ...process.env, PSModulePath: "Z:\\invalid-modules" } },
          args[3],
        ]);
      });
      const unicodeTemp = await mkdtemp(join(tmpdir(), "signature-temp-‘’‚‛-"));
      const root = await mkdtemp(join(unicodeTemp, "signature-测试'‘’‚‛-"));
      const originalTemp = process.env.TEMP;
      const originalTmp = process.env.TMP;
      try {
        process.env.TEMP = unicodeTemp;
        process.env.TMP = unicodeTemp;
        const unsigned = join(root, "unsigned'‘’‚‛;&.exe");
        await writeFile(unsigned, "not a signed executable");
        expect(await verifyWindowsAuthenticodeSignature(unsigned)).not.toBeNull();
        const signed = join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const signedCopy = join(root, "signed'‘’‚‛;&.exe");
        await copyFile(signed, signedCopy);
        expect(await verifyWindowsAuthenticodeSignature(signedCopy)).toBeNull();
        expect(await verifyWindowsAuthenticodeSignature(signed)).toBeNull();
      } finally {
        spy.mockRestore();
        if (originalTemp === undefined) delete process.env.TEMP;
        else process.env.TEMP = originalTemp;
        if (originalTmp === undefined) delete process.env.TMP;
        else process.env.TMP = originalTmp;
        await rm(unicodeTemp, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
