import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { delimiter, join, dirname } from "node:path";
import {
  agentCommand,
  bash,
  config,
  directory,
  docs,
  tools,
  entries,
  entryDefinition,
  entryPath,
  hash,
  isWindows,
  record,
  put,
  get,
  execute,
  selected,
  plugin,
  tree,
  snapshots,
  ancestors,
  assertSameAgent,
} from "./runtime.mjs";

// 应用签名只有 macOS 有；其他平台没有对应的系统级校验，不伪造通过。
const verifySignatures = async () => {
  if (process.platform !== "darwin") return "not-applicable";
  await execute("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    join((await record("libreoffice")).installationDir, "LibreOffice.app"),
  ]);
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", config.systemApplication]);
  return "valid-before-and-after";
};
const sameFile = (actual, expected) =>
  isWindows ? actual?.toLowerCase() === expected.toLowerCase() : actual === expected;

assert.equal(process.env.ZCODE_PREINSTALLED_TOOLS_AVAILABLE, "1");
assert.ok(sameFile(process.env.PATH.split(delimiter)[0], join(config.root, "bin")));
assert.equal(process.env.PYTHONDONTWRITEBYTECODE, undefined);
assert.equal(process.env.PYTHONPYCACHEPREFIX, undefined);
const phase = process.argv[2];
const documentChecks = join(directory, "document_checks.py");
const workbook = join(docs, "公式 样例.xlsx");
const selection = async () =>
  Object.fromEntries(
    await Promise.all(tools.map(async (id) => [id, await Promise.all(entries[id].map(selected))])),
  );
let result;
if (phase === "before") {
  for (const id of tools)
    await assert.rejects(access(join(config.root, "tools", id, "installation.json")), {
      code: "ENOENT",
    });
  // macOS 在隔离 HOME 下放系统应用链接；Windows 的系统 LibreOffice 本来就在 Program Files，由插件正常发现。
  if (process.platform === "darwin") {
    const applications = join(dirname(config.storageRoot), "Applications");
    await mkdir(applications, { recursive: true });
    await symlink(config.systemApplication, join(applications, "LibreOffice.app"));
  }
  const systemOnlyPath = isWindows
    ? [join(process.env.SystemRoot, "System32"), process.env.SystemRoot].join(delimiter)
    : "/usr/bin:/bin";
  const documents = await plugin("documents");
  const initial = await execute(
    config.python,
    [join(documents, "scripts/zcode_libreoffice.py"), "check"],
    0,
    { env: { ...process.env, PATH: systemOnlyPath } },
  );
  const systemCheck = JSON.parse(initial.stdout);
  assert.equal(systemCheck.source, "system");
  await execute(config.python, [documentChecks, "prepare"]);
  const inputHashes = Object.fromEntries(
    await Promise.all(
      [
        "中文 字体验收.docx",
        "中文 字体验收.pptx",
        "legacy/中文 字体验收.doc",
        "公式 样例.xlsx",
      ].map(async (name) => [name, await hash(join(docs, name))]),
    ),
  );
  const profile = await tree(config.defaultProfile);
  await put("default-profile-before", profile);
  result = {
    inputHashes,
    snapshots: await snapshots(),
    ancestors: await ancestors(),
    systemCheck,
    systemNotice: initial.stderr,
    selected: await selection(),
    defaultProfileFiles: Object.keys(profile).length,
  };
} else if (phase === "main") {
  const continuity = await assertSameAgent();
  const initial = await get("before");
  for (const [name, digest] of Object.entries(initial.inputHashes))
    assert.equal(await hash(join(docs, name)), digest);
  const installed = Object.fromEntries(
    await Promise.all(tools.map(async (id) => [id, await record(id)])),
  );
  const pythonBase = join(installed.python.installationDir, "python");
  await put("python-base-before", await tree(pythonBase));
  const roots = Object.fromEntries(
    await Promise.all(
      ["documents", "pdf", "spreadsheets", "presentations"].map(async (name) => [
        name,
        await plugin(name),
      ]),
    ),
  );
  await put(
    "plugins",
    Object.fromEntries(
      await Promise.all(
        Object.entries(roots).map(async ([name, path]) => [
          name,
          {
            path,
            metadata: JSON.parse(await readFile(join(path, ".zcode-plugin/plugin.json"), "utf8")),
          },
        ]),
      ),
    ),
  );
  for (const id of tools)
    for (const name of entries[id])
      assert.ok(sameFile(await selected(name), entryPath(name)), `${name} 未解析到预装入口`);
  await verifySignatures();
  const runPlugin = (label, path, args, expected = 0) =>
    execute("zcode-python", [documentChecks, "run", label, path, ...args], expected);
  await runPlugin(
    "documents",
    join(roots.documents, "skills/docx/scripts/add_toc_placeholders.py"),
    [join(docs, "目录.docx"), "--auto"],
  );
  const palette = await runPlugin("pdf", join(roots.pdf, "skills/pdf/scripts/pdf.py"), [
    "palette.generate",
    "--title",
    "预装验收",
    "--format",
    "json",
    "--seed",
    "12",
  ]);
  await writeFile(join(directory, "palette.json"), palette.stdout);
  await execute("zcode-python", [documentChecks, "report"]);
  for (const name of ["Word PDF", "PPT PDF", "旧文档"])
    await mkdir(join(docs, name), { recursive: true });
  // 两个独立文档并行转换，复用真实插件的隔离配置；不会共享用户默认 profile。
  await Promise.all([
    runPlugin("word-conversion", join(roots.documents, "scripts/zcode_libreoffice.py"), [
      "run",
      "--",
      "--convert-to",
      "pdf",
      "--outdir",
      join(docs, "Word PDF"),
      join(docs, "中文 字体验收.docx"),
    ]),
    runPlugin("presentations", join(roots.presentations, "scripts/zcode_libreoffice.py"), [
      "run",
      "--",
      "--convert-to",
      "pdf",
      "--outdir",
      join(docs, "PPT PDF"),
      join(docs, "中文 字体验收.pptx"),
    ]),
  ]);
  await runPlugin("legacy-word", join(roots.documents, "scripts/zcode_libreoffice.py"), [
    "run",
    "--",
    "--convert-to",
    "docx",
    "--outdir",
    join(docs, "旧文档"),
    join(docs, "legacy/中文 字体验收.doc"),
  ]);
  await runPlugin("office", join(roots.pdf, "skills/pdf/scripts/pdf.py"), [
    "convert.office",
    join(docs, "中文 字体验收.docx"),
    "--output",
    join(docs, "Office PDF.pdf"),
  ]);
  const recalc = JSON.parse(
    (
      await runPlugin(
        "spreadsheets",
        join(roots.spreadsheets, "skills/xlsx/xlsx.py"),
        ["recalc", workbook, "120"],
        1,
      )
    ).stdout,
  );
  assert.equal(recalc.status, "errors_found");
  assert.equal(recalc.total_errors, 1);
  assert.equal(recalc.total_formulas, 2);
  assert.equal(recalc.libreoffice_source, "managed");
  assert.deepEqual(recalc.error_summary["#DIV/0!"].locations, ["Sheet!D1"]);
  await put("recalculation", recalc);
  await runPlugin("pdf2image", join(roots.pdf, "skills/pdf/scripts/pdf.py"), [
    "form.render",
    join(docs, "Word PDF/中文 字体验收.pdf"),
    join(docs, "Word images"),
  ]);
  await execute("pdftoppm", [
    "-png",
    "-r",
    "110",
    join(docs, "PPT PDF/中文 字体验收.pdf"),
    join(docs, "PPT PDF/slide"),
  ]);
  await execute("zcode-python", [documentChecks, "check"]);
  const checks = await get("document-results");
  const render = await get("runtime-pdf2image");
  // pdf2image 在 Windows 上调用 pdftoppm.exe；两种写法都按 PATH 上实际解析到的程序核对。
  const pdftoppm = render.subprocesses.filter((item) =>
    /^pdftoppm(?:\.exe)?$/i.test(item.executable),
  );
  assert.ok(pdftoppm.length > 0);
  const binDir = join(config.root, "bin");
  assert.ok(
    pdftoppm.every(
      (item) =>
        sameFile(item.resolved, join(binDir, "pdftoppm")) ||
        (isWindows &&
          item.resolved?.toLowerCase().startsWith(`${binDir.toLowerCase()}\\pdftoppm.`)),
    ),
    JSON.stringify(pdftoppm),
  );
  for (const name of ["documents", "pdf", "spreadsheets", "presentations", "pdf2image"]) {
    const receipt = await get(`runtime-${name}`);
    assert.ok(receipt.executable.startsWith(join(installed.python.installationDir, "overlay")));
    // PDF/xlsx已有脚本会自行禁写缓存；入口默认策略在脚本执行前取证，不改插件行为。
    assert.equal(receipt.startupPolicy.dontWriteBytecode, false);
    assert.equal(receipt.startupPolicy.pycachePrefix, null);
    assert.equal(receipt.pycachePrefix, null);
  }
  const defaultImports = JSON.parse(
    (
      await execute("zcode-python", [
        "-c",
        "import sys,json; assert not sys.dont_write_bytecode; assert sys.pycache_prefix is None; import openpyxl,xlsxwriter,defusedxml,docx,lxml,reportlab,pypdf,pikepdf,pdfplumber,pypdfium2,pdf2image,PIL,pptx,matplotlib,pandas,numpy; print(json.dumps({'dontWriteBytecode':sys.dont_write_bytecode,'pycachePrefix':sys.pycache_prefix,'executable':sys.executable}))",
      ])
    ).stdout,
  );
  await put("default-cache-imports", defaultImports);
  await execute("zcode-python", [
    "-m",
    "pip",
    "install",
    "--no-index",
    "--no-deps",
    join(docs, "zcode_full_chain_probe-1.0-py3-none-any.whl"),
  ]);
  const addon = JSON.parse(
    (
      await execute("zcode-python", [
        "-c",
        "import json,zcode_full_chain_probe as p;print(json.dumps({'value':p.value,'path':p.__file__}))",
      ])
    ).stdout,
  );
  assert.equal(addon.value, "overlay-only");
  assert.ok(addon.path.startsWith(join(installed.python.installationDir, "overlay")));
  await put("addon", addon);
  await writeFile(
    join(installed.python.installationDir, "overlay", "acceptance-marker.txt"),
    "preserve while disabled; remove with resource",
  );
  result = {
    ...continuity,
    plugins: Object.keys(roots),
    formulas: checks.formulas,
    pdf2imageEntry: pdftoppm[0].resolved,
    installed,
    selections: await selection(),
    checks,
  };
} else if (phase.endsWith("-off") || phase.endsWith("-on")) {
  const continuity = await assertSameAgent();
  const disabled = phase.endsWith("-off") ? phase.slice(0, -4) : null;
  const selections = await selection();
  for (const id of tools)
    for (let index = 0; index < entries[id].length; index++) {
      // Git Bash 解析 shim 入口得到 <name>.exe；比较无扩展名路径会让“已关闭”断言恒为真。
      const managed = entryPath(entries[id][index]);
      if (id === disabled) assert.ok(!sameFile(selections[id][index], managed));
      else
        assert.ok(
          sameFile(selections[id][index], managed),
          `${entries[id][index]} 未解析到预装入口`,
        );
    }
  let actual;
  let pluginSelection;
  if (disabled === "python") {
    // 插件的原写法；Windows 上 python3 常是应用商店占位程序，失败也如实记录，只断言未用预装版本。
    pluginSelection = await execute(
      bash,
      [
        "-c",
        '"$(command -v zcode-python || command -v python3)" -c "import sys;print(sys.executable)"',
      ],
      isWindows ? null : 0,
    );
    actual = pluginSelection.stdout.trim();
    assert.ok(!actual.startsWith((await record("python")).installationDir));
  } else {
    actual = (
      await execute("zcode-python", ["-c", "import sys;print(sys.executable)"])
    ).stdout.trim();
    assert.ok(actual.startsWith((await record("python")).installationDir));
  }
  if (phase.startsWith("libreoffice")) {
    const check = await execute("zcode-python", [
      join(await plugin("documents"), "scripts/zcode_libreoffice.py"),
      "check",
    ]);
    assert.equal(JSON.parse(check.stdout).source, disabled ? "system" : "managed");
    if (disabled) assert.ok(check.stderr.includes("未就绪或已关闭"));
  }
  assert.equal(
    await readFile(
      join((await record("python")).installationDir, "overlay/acceptance-marker.txt"),
      "utf8",
    ),
    "preserve while disabled; remove with resource",
  );
  result = {
    ...continuity,
    disabled,
    selections,
    pythonExecutable: actual,
    ...(pluginSelection
      ? {
          pluginSelection: {
            code: pluginSelection.code,
            stdout: pluginSelection.stdout,
            stderr: pluginSelection.stderr,
          },
        }
      : {}),
  };
} else if (phase === "fallbacks") {
  await assertSameAgent();
  await execute("zcode-python", [join(directory, "fallback_checks.py")]);
  result = await get("fallback-results");
} else if (phase.startsWith("upgrade-")) {
  const currentAncestors = await ancestors();
  const agent = currentAncestors.find((item) => agentCommand.test(item.command));
  assert.ok(agent, JSON.stringify(currentAncestors));
  const continuity = {
    agentPid: agent.pid,
    ancestors: currentAncestors,
    snapshots: await snapshots(),
  };
  if (phase === "upgrade-after") {
    const prior = await get("upgrade-before");
    assert.equal(continuity.agentPid, prior.agentPid);
    assert.deepEqual(continuity.snapshots, prior.snapshots);
  }
  const installation = await record("qpdf");
  // resourceId 由测试从真实 .artifact.json 读出，不按平台写死。
  const expected =
    phase === "upgrade-before" ? config.qpdfResourceIds.before : config.qpdfResourceIds.after;
  assert.equal(installation.resourceId, expected);
  const text = await entryDefinition("qpdf");
  assert.ok(text.includes(installation.installationDir));
  const version = await execute("qpdf", ["--version"]);
  await execute("qpdf", ["--check", join(docs, "Office PDF.pdf")]);
  result = {
    ...continuity,
    resourceId: installation.resourceId,
    entry: text,
    version: version.stdout,
  };
} else if (phase === "finish") {
  const continuity = await assertSameAgent();
  assert.deepEqual(
    await tree(join((await record("python")).installationDir, "python")),
    await get("python-base-before"),
  );
  assert.deepEqual(await tree(config.defaultProfile), await get("default-profile-before"));
  const signatures = await verifySignatures();
  result = {
    ...continuity,
    pythonBaseUnchanged: true,
    defaultProfileUnchanged: true,
    signatures,
  };
} else throw new Error(`Unknown phase: ${phase}`);
await put(phase, result);
console.log(JSON.stringify({ phase, success: true, ...(phase === "before" ? result : {}) }));
