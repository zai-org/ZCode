import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExecutionShellSelection } from "@zcode/contracts";
import {
  exampleCmdExecutedShellCheck,
  exampleCmdShellReadOnlyCheck,
} from "../../src/tool/cmd-readonly/contract.example.js";
import { setCmdReadonlyHostForTest } from "../../src/tool/handlers/bash-cmd-readonly-policy.js";

const CMD: ExecutionShellSelection = {
  dialect: "cmd",
  display: { name: "CMD" },
  path: String.raw`C:\Windows\System32\cmd.exe`,
  source: "user-config",
};

afterEach(() => setCmdReadonlyHostForTest(undefined));

it("只在 Windows 的 cmd.exe 上按 CMD 语法放行只读命令", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "zcode-cmd-contract-"));
  try {
    setCmdReadonlyHostForTest({
      platform: "win32",
      env: { PATH: String.raw`C:\Windows`, SystemRoot: String.raw`C:\Windows` },
      // 只有系统目录和系统 cmd.exe 存在。
      realpath: (path) =>
        [String.raw`C:\Windows`, CMD.path!].find(
          (known) => known.toLowerCase() === path.toLowerCase(),
        ),
    });
    expect(exampleCmdExecutedShellCheck(CMD)).toBe(true);
    const context = { bashShellSelection: CMD, workingDirectory };
    expect(exampleCmdShellReadOnlyCheck("dir /b", context)).toBe(true);
    expect(exampleCmdShellReadOnlyCheck("where node", context)).toBe(true);
    expect(exampleCmdShellReadOnlyCheck(String.raw`type # & python x.py`, context)).toBe(false);

    setCmdReadonlyHostForTest({ platform: "linux", env: {} });
    expect(exampleCmdExecutedShellCheck(CMD)).toBe(false);
    expect(exampleCmdShellReadOnlyCheck("dir /b", context)).toBe(false);
  } finally {
    rmSync(workingDirectory, { force: true, recursive: true });
  }
});
