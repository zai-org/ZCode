import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfig, createConfigWithPluginMigrations } from "../src/config/index.js";
import {
  buildWorkspaceHookBundleSnapshot,
  identifyWorkspaceHookScriptPath,
  readWorkspaceHookProjectSources,
  readWorkspaceHookScriptState,
  readWorkspaceHookScriptStates,
  resolveWorkspaceHookRuntimeRoot,
  type WorkspaceHookDefinition,
} from "@zcode/shared/workspace-hook-discovery";

/**
 * D24（ZP-20261110-06）：Trust 绑定直接入口脚本内容。
 * 修复前 declaration digest 不含脚本内容，声明不变、只换脚本时旧 Trust 继续放行。
 */

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-script-entry-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function writeHooks(workspace: string, hooks: WorkspaceHookDefinition[]): Promise<void> {
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(
    join(workspace, ".zcode", "config.json"),
    JSON.stringify({ hooks: { enabled: true, events: { SessionStart: [{ hooks }] } } }),
    "utf8",
  );
}

async function snapshotOf(workspace: string) {
  const { sources } = await readWorkspaceHookProjectSources({ workingDirectory: workspace });
  const scriptStates = await readWorkspaceHookScriptStates({ workspacePath: workspace, sources });
  return buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: workspace,
    workspacePath: workspace,
    sources,
    runtimeRoot: resolveWorkspaceHookRuntimeRoot([...sources.map((source) => source.hooks)]),
    scriptStates,
  })!;
}

describe("identifyWorkspaceHookScriptPath", () => {
  // 识别结果与平台有关（Windows 上 command 不识别）：这里固定按 POSIX 断言，Windows 用例单独传 "win32"，
  // 保证同一份断言在 Windows CI 上也成立。
  const command = (value: string, shell?: true | string) =>
    identifyWorkspaceHookScriptPath(
      {
        type: "command",
        command: value,
        ...(shell === undefined ? {} : { shell }),
      },
      "linux",
    );
  const processHook = (value: string, args?: string[]) =>
    identifyWorkspaceHookScriptPath(
      { type: "process", command: value, ...(args ? { args } : {}) },
      "linux",
    );

  it.each([
    ["./scripts/x.sh", "scripts/x.sh"],
    ["scripts/x.sh --log=out.log", "scripts/x.sh"],
    ["bash .zcode/hook.sh", ".zcode/hook.sh"],
    ["bash hook.sh", "hook.sh"],
    ["node .zcode/audit.mjs --log=.zcode/audit.log", ".zcode/audit.mjs"],
    ["python3 tools/check.py arg", "tools/check.py"],
    ['"$CLAUDE_PROJECT_DIR"/hooks/x.sh', "hooks/x.sh"],
    ['bash "$ZCODE_PROJECT_DIR"/x.sh', "x.sh"],
  ])("command %s → %s", (value, expected) => {
    expect(command(value)).toBe(expected);
    expect(command(value, true)).toBe(expected);
  });

  it.each([
    "echo hello",
    "x.sh",
    "true",
    "cd scripts && ./x.sh",
    "./x.sh | tee out.log",
    "./x.sh > out.log",
    "bash -c ./x.sh",
    "node --experimental-strip-types x.ts",
    "python -m tool",
    "npx some-tool",
    "npm run hook",
    "'./x.sh'",
    "./x.sh $(date)",
    "/abs/x.sh",
    "../x.sh",
    "bash ../x.sh",
    "./a/../x.sh",
    "${ZCODE_PROJECT_DIR}/../x.sh",
    "/bin/bash x.sh",
    "bash",
    "~/x.sh",
    ".\\x.ps1",
  ])("command %s 不识别", (value) => {
    expect(command(value)).toBeUndefined();
  });

  // CR SG-01：换行是 shell 的命令分隔符。曾在空白切分时被吞掉，多行命令被误识别为只绑定首行脚本。
  it.each(["bash good.sh\nnode other.js", "bash good.sh\r\nnode other.js", "./good.sh\n"])(
    "多行命令 %j 不识别",
    (value) => {
      expect(command(value)).toBeUndefined();
    },
  );

  // 第二轮 CR-01：按 \s 切分会吞掉非 ASCII 空白，shell 不按它们分词，绑定与执行的文件会不同；
  // % 会被 cmd.exe 展开。第二轮 SG-01：含 : 的路径在 Windows 上是盘符相对路径或备用数据流。
  it.each([
    "bash .zcode/check.sh\u00a0run",
    "./.zcode/check.sh\u00a0",
    "bash\u3000good.sh",
    "bash good.sh\varg",
    "bash good.sh\farg",
    "node .zcode/%OS%.js",
    "node C:hook.js",
    "node sub/x:y.js",
  ])("%j 不识别", (value) => {
    expect(command(value)).toBeUndefined();
  });

  // 第三轮 CR-01：首个 token 可能是 shell 的赋值前缀；cmd.exe 把未加引号的 , = 当分隔符并去掉开头的 @。
  // 这些写法曾把赋值或整串当作脚本路径，绑定的文件不是实际执行的文件，或合法 Hook 被误判 missing。
  it.each([
    "ENV=decoy/ok bash .zcode/h.sh",
    "PYTHONPATH=tools/lib python3 tools/check.py",
    "node,.zcode/h.js",
    "python=.zcode/h.py",
    "@scripts/hook.cmd",
    "bash @scripts/h.sh",
    "bash a,b/h.sh",
  ])("赋值前缀与 cmd.exe 分隔写法 %j 不识别", (value) => {
    expect(command(value)).toBeUndefined();
  });

  it("参数中的 --flag=value 不影响识别", () => {
    expect(command("scripts/x.sh --log=out/a.log")).toBe("scripts/x.sh");
  });

  // 第四轮 CR-01：Windows 上 command 经 cmd.exe 执行，它把 / 当开关、先在 cwd 找 node.cmd 等同名程序。
  // 不再用字符规则近似 cmd.exe：Windows 上 command 类型一律不识别入口，回到声明级信任（spec §12.9）。
  it.each(["scripts/x.sh", "./x.sh", "node .zcode/h.js", "bash .zcode/hook.sh"])(
    "Windows 上 command %j 不识别",
    (value) => {
      expect(
        identifyWorkspaceHookScriptPath({ type: "command", command: value }, "win32"),
      ).toBeUndefined();
    },
  );

  it("Windows 上 process 解释器写法与带扩展名的直接执行仍识别；无扩展名的直接执行不识别", () => {
    const win = (command: string, args?: string[]) =>
      identifyWorkspaceHookScriptPath(
        { type: "process", command, ...(args ? { args } : {}) },
        "win32",
      );
    expect(win("node", [".zcode/h.js"])).toBe(".zcode/h.js");
    expect(win("./tools/check.exe")).toBe("tools/check.exe");
    // 无扩展名时 Windows 会按 PATHEXT 补 .cmd/.exe，执行的不是绑定的文件。
    expect(win("./tools/check")).toBeUndefined();
  });

  it.each(["bash +x/h.sh", "./a+b.sh", "bash a@b/h.sh"])(
    "脚本 token 超出 [A-Za-z0-9_./-] 的 %j 不识别",
    (value) => {
      expect(command(value)).toBeUndefined();
    },
  );

  // 第五轮 SG-01：command 里未加引号的目录变量会被 shell 按 cwd 中的空格拆开；${VAR} 先被文本替换，
  // cwd 中的 " $ 反引号仍会被 shell 解释。只保留由 shell 在引号内展开的 "$VAR"/ 写法。
  // 第五轮需确认项：解释器后的无路径名字可能是子命令（node inspect x.js 加载的是 x.js），须带扩展名。
  it.each([
    "${ZCODE_PROJECT_DIR}/x.sh",
    "$ZCODE_PROJECT_DIR/x.sh",
    'bash "${ZCODE_PROJECT_DIR}"/x.sh',
    "bash $CLAUDE_PROJECT_DIR/x.sh",
    "bash hook",
    "node inspect payload.js",
  ])("command %j 不识别", (value) => {
    expect(command(value)).toBeUndefined();
  });

  it("process 解释器后的无路径名字须带扩展名", () => {
    expect(processHook("node", ["inspect", "payload.js"])).toBeUndefined();
    expect(processHook("bash", ["hook"])).toBeUndefined();
    expect(processHook("node", ["hook.mjs"])).toBe("hook.mjs");
  });

  it("tab 分隔的命令仍可识别", () => {
    expect(command("bash\tgood.sh\targ")).toBe("good.sh");
  });

  it.each([
    ["node", ["C:hook.js"]],
    ["C:hook.js", []],
  ] as const)("process %s %j 含冒号不识别", (file, args) => {
    expect(processHook(file, [...args])).toBeUndefined();
  });

  it("自定义 shell 字符串不识别", () => {
    expect(command("./x.sh", "/bin/zsh")).toBeUndefined();
  });

  it.each([
    [["node", [".zcode/audit.mjs", "--log=.zcode/audit.log"]], ".zcode/audit.mjs"],
    [["./scripts/x.sh", ["a b"]], "scripts/x.sh"],
    [["${ZCODE_PROJECT_DIR}/x.sh", []], "x.sh"],
    [["bash", ["${CLAUDE_PROJECT_DIR}/x.sh"]], "x.sh"],
  ] as const)("process %j → %s", ([file, args], expected) => {
    expect(processHook(file, [...args])).toBe(expected);
  });

  it.each([
    ["node", ["--inspect", "x.js"]],
    ["node", []],
    ["git", ["status"]],
    ["x.sh", []],
    ["/usr/bin/x", []],
    ["node", ["../x.js"]],
    ["node", ["${CLAUDE_PLUGIN_ROOT}/x.js"]],
  ] as const)("process %s %j 不识别", (file, args) => {
    expect(processHook(file, [...args])).toBeUndefined();
  });
});

describe("readWorkspaceHookScriptState", () => {
  it("普通文件记录 sha256，不存在记为 missing，目录记为 unverifiable", async () => {
    const workspace = makeRoot();
    await writeFile(join(workspace, "x.sh"), "echo one\n", "utf8");
    await mkdir(join(workspace, "dir"));

    const file = await readWorkspaceHookScriptState(workspace, "x.sh");
    expect(file).toEqual({ kind: "file", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(await readWorkspaceHookScriptState(workspace, "nope.sh")).toEqual({ kind: "missing" });
    expect(await readWorkspaceHookScriptState(workspace, "x.sh/child")).toEqual({
      kind: "missing",
    });
    expect(await readWorkspaceHookScriptState(workspace, "dir")).toEqual({ kind: "unverifiable" });

    const aborted = new AbortController();
    aborted.abort();
    expect(await readWorkspaceHookScriptState(workspace, "x.sh", aborted.signal)).toEqual({
      kind: "unverifiable",
    });
  });
});

describe("workspace hook snapshot 绑定入口脚本（D24）", () => {
  it("只改脚本内容时 declaration digest 变化；只改数据文件时不变", async () => {
    const workspace = makeRoot();
    await writeHooks(workspace, [
      // process 写法在所有平台都绑定入口，Windows CI 上同样成立。
      { type: "process", command: "bash", args: [".zcode/hook.sh", "--log=.zcode/hook.log"] },
    ]);
    await writeFile(join(workspace, ".zcode", "hook.sh"), "echo one\n", "utf8");
    await writeFile(join(workspace, ".zcode", "hook.log"), "a\n", "utf8");

    const before = await snapshotOf(workspace);
    expect(before.hooks[0]?.scriptEntry).toEqual({
      path: ".zcode/hook.sh",
      state: { kind: "file", sha256: expect.any(String) },
    });

    await writeFile(join(workspace, ".zcode", "hook.log"), "a\nb\n", "utf8");
    const dataChanged = await snapshotOf(workspace);
    expect(dataChanged.hooks[0]?.hookDeclarationDigest).toBe(before.hooks[0]?.hookDeclarationDigest);

    await writeFile(join(workspace, ".zcode", "hook.sh"), "echo two\n", "utf8");
    const scriptChanged = await snapshotOf(workspace);
    expect(scriptChanged.hooks[0]?.hookDeclarationDigest).not.toBe(
      before.hooks[0]?.hookDeclarationDigest,
    );
  });

  it("无法识别入口的声明没有 scriptEntry，digest 与不读脚本时相同", async () => {
    const workspace = makeRoot();
    await writeHooks(workspace, [{ type: "command", command: "cd .zcode && ./hook.sh" }]);
    const { sources } = await readWorkspaceHookProjectSources({ workingDirectory: workspace });
    const runtimeRoot = resolveWorkspaceHookRuntimeRoot([...sources.map((s) => s.hooks)]);
    const withStates = await snapshotOf(workspace);
    const withoutStates = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot,
    })!;
    expect(withStates.hooks[0]?.scriptEntry).toBeUndefined();
    expect(withStates.hooks[0]?.hookDeclarationDigest).toBe(
      withoutStates.hooks[0]?.hookDeclarationDigest,
    );
  });

  it("入口不存在记为 missing；文件出现后 digest 变化", async () => {
    const workspace = makeRoot();
    await writeHooks(workspace, [{ type: "process", command: "sh", args: ["scripts/x.sh"] }]);
    const missing = await snapshotOf(workspace);
    expect(missing.hooks[0]?.scriptEntry).toEqual({
      path: "scripts/x.sh",
      state: { kind: "missing" },
    });

    await mkdir(join(workspace, "scripts"));
    await writeFile(join(workspace, "scripts", "x.sh"), "echo hi\n", "utf8");
    const created = await snapshotOf(workspace);
    expect(created.hooks[0]?.scriptEntry?.state.kind).toBe("file");
    expect(created.hooks[0]?.hookDeclarationDigest).not.toBe(
      missing.hooks[0]?.hookDeclarationDigest,
    );
  });

  it("未提供 scriptStates 时能识别入口的条目记为 unverifiable，不退回旧 digest", async () => {
    const workspace = makeRoot();
    await writeHooks(workspace, [{ type: "process", command: "sh", args: ["x.sh"] }]);
    await writeFile(join(workspace, "x.sh"), "echo hi\n", "utf8");
    const { sources } = await readWorkspaceHookProjectSources({ workingDirectory: workspace });
    const snapshot = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot: resolveWorkspaceHookRuntimeRoot([...sources.map((s) => s.hooks)]),
    })!;
    expect(snapshot.hooks[0]?.scriptEntry).toEqual({
      path: "x.sh",
      state: { kind: "unverifiable" },
    });
  });

  it("Runtime 异步入口与 Settings 公式得到同一 scriptEntry；同步 createConfig 为 unverifiable", async () => {
    const home = makeRoot();
    const workspace = makeRoot();
    await writeHooks(workspace, [{ type: "process", command: "node", args: ["hook.mjs"] }]);
    await writeFile(join(workspace, "hook.mjs"), "console.log(1)\n", "utf8");
    const options = {
      workingDirectory: workspace,
      userConfigPath: join(home, ".zcode", "cli", "config.json"),
      env: {},
    };

    const runtime = (await createConfigWithPluginMigrations(options)).sources.project
      .workspaceHookSnapshot!;
    const settings = await snapshotOf(workspace);
    expect(runtime.hooks[0]?.scriptEntry).toEqual(settings.hooks[0]?.scriptEntry);
    expect(runtime.hooks[0]?.scriptEntry?.state.kind).toBe("file");

    const sync = createConfig(options).sources.project.workspaceHookSnapshot!;
    expect(sync.hooks[0]?.scriptEntry?.state).toEqual({ kind: "unverifiable" });
  });
});
