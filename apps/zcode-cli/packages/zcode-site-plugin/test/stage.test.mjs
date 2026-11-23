// packStage / checkStage 测试：在临时目录里搭 stage，检查产物包内容、契约检查和本地启动检查。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkStage, classifyBinary, packStage } from "../skills/site-deploy/scripts/stage.mjs";

async function stage(files) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-site-stage-"));
  const root = join(dir, "stage");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return { dir, root };
}

function elf(machine) {
  const head = Buffer.alloc(64);
  head.write("\x7fELF", 0, "latin1");
  head[4] = 2; // 64 位
  head[5] = 1; // 小端
  head.writeUInt16LE(machine, 18);
  return head;
}

function macho() {
  const head = Buffer.alloc(64);
  head.writeUInt32LE(0xfeedfacf, 0);
  return head;
}

test("classifyBinary tells linux x86-64 apart from other native code", () => {
  assert.deepEqual(classifyBinary(elf(0x3e)), { linux: true });
  assert.equal(classifyBinary(elf(0xb7)).linux, false); // aarch64
  assert.equal(classifyBinary(macho()).linux, false);
  assert.equal(classifyBinary(Buffer.from("#!/usr/bin/env bash\n")), undefined);
});

test("pack writes the stage as a gzip tar and skips local-only files", async () => {
  const { dir, root } = await stage({
    "start.sh": "exec node server.js\n",
    "server.js": "",
    [`public/${"a".repeat(120)}.html`]: "long name",
    "public/中文.html": "non-ascii name",
    "lib/addon.node": elf(0x3e),
    ".DS_Store": "",
    ".zcode-site.json": "{}",
    ".git/HEAD": "ref",
  });
  await chmod(join(root, "server.js"), 0o755);
  const packed = await packStage(root, { cwd: dir });
  assert.deepEqual(packed.warnings, []);
  assert.equal(packed.result.packageBytes, packed.body.length);
  const out = join(dir, "package.tar.gz");
  await writeFile(out, packed.body);
  assert.equal(packed.result.files, 5);
  assert.equal(packed.result.linuxBinaries, 1);

  const listing = execFileSync("tar", ["-tvzf", out], { encoding: "utf8" });
  const names = execFileSync("tar", ["-tzf", out], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(names, [
    "lib/addon.node",
    `public/${"a".repeat(120)}.html`,
    "public/中文.html",
    "server.js",
    "start.sh",
  ]);
  assert.match(listing, /^-rwxr-xr-x.*lib\/addon\.node$/m);
  assert.match(listing, /^-rwxr-xr-x.*server\.js$/m);
  assert.match(listing, /^-rw-r--r--.*start\.sh$/m);
});

test("pack lists every contract problem and builds no package", async () => {
  const { dir, root } = await stage({
    "start.sh": "exec node server.js\r\n",
    "package.json": JSON.stringify({ dependencies: { express: "^5" } }),
    ".env": "SECRET=1",
    ".env.example": "SECRET=",
    "bin/tool": macho(),
    ".__zcode/x": "",
  });
  await symlink("missing", join(root, "broken"));
  const packed = await packStage(root, { cwd: dir });
  assert.equal(packed.body, undefined);
  const text = packed.problems.join("\n");
  for (const word of ["CRLF", "node_modules", ".env", "bin/tool", ".__zcode", "broken"])
    assert.ok(text.includes(word), `${word} in:\n${text}`);
  assert.ok(!text.includes(".env.example"));

  const allowed = await packStage(root, { cwd: dir, allowForeignBinaries: true });
  assert.ok(allowed.problems.every((p) => !p.includes("bin/tool")));
});

test("pack rejects a missing start.sh and a missing stage", async () => {
  const { dir, root } = await stage({ "index.html": "" });
  assert.ok((await packStage(root, { cwd: dir })).problems.some((p) => p.includes("start.sh")));
  assert.equal((await packStage(join(dir, "none"), { cwd: dir })).error, "STAGE_NOT_FOUND");
});

const posix = process.platform !== "win32";

test("check reports a server that answers as live", { skip: !posix }, async () => {
  const { dir, root } = await stage({
    "start.sh": `exec node -e 'require("http").createServer((q,s)=>{s.end("ok")}).listen(process.env.PORT,"0.0.0.0",()=>console.log("up"))'\n`,
  });
  const checked = await checkStage(root, { cwd: dir, port: 13871, timeoutMs: 20000 });
  assert.equal(checked.result?.status, "live", JSON.stringify(checked));
  assert.equal(checked.result.httpStatus, 200);
});

test("check reports a start.sh that exits", { skip: !posix }, async () => {
  const { dir, root } = await stage({ "start.sh": "echo starting; exit 0\n" });
  const checked = await checkStage(root, { cwd: dir, port: 13872, timeoutMs: 20000 });
  assert.ok(checked.failed, JSON.stringify(checked));
  assert.ok(checked.failed.log.includes("starting"));
});

test("check skips a stage with linux binaries on another platform", async () => {
  const { dir, root } = await stage({ "start.sh": "exec ./app\n", app: elf(0x3e) });
  const checked = await checkStage(root, { cwd: dir, platform: "darwin", arch: "arm64" });
  assert.equal(checked.result?.status, "skipped", JSON.stringify(checked));
});
