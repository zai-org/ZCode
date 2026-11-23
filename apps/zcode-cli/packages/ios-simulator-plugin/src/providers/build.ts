import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { data, inside, rel } from "../lib/path.js";
import { brief, ok, run, type Run } from "../lib/run.js";
import { boot, install, launch } from "./sim.js";
import { bundle, discover, source } from "./project.js";

type Build = {
  project?: string;
  workspace?: string;
  scheme?: string;
  configuration?: string;
  device?: string;
  udid?: string;
  runtime?: string;
  derivedDataPath?: string;
  bundleId?: string;
  openSimulator?: boolean;
  timeoutMs?: number;
};

type RunApp = Build & {
  launchArgs?: string[];
};

const PROJECT_LIST_TIMEOUT_MS = 30_000;

export async function app(input: Build = {}) {
  const found = await discover();
  const src = source(input, found);
  // 动态列举会求值项目清单，只能放在构建入口；对已选中的源查询，不能隐式执行另一份 workspace。
  if (!input.scheme)
    src.scheme =
      (await schemesFor(src.flag, src.file))[0] || path.basename(src.file, path.extname(src.file));
  if (!src.scheme) throw new Error("No scheme found. Pass scheme explicitly.");

  const sim = await boot({
    udid: input.udid,
    name: input.device,
    runtime: input.runtime,
    open: input.openSimulator,
  });
  const dir = input.derivedDataPath
    ? inside(process.cwd(), input.derivedDataPath)
    : path.join(await data("DerivedData"), key(`${process.cwd()}:${src.file}:${src.scheme}`));
  await mkdir(dir, { recursive: true });
  const config = input.configuration || "Debug";

  const out = await run(
    [
      "xcodebuild",
      src.flag,
      src.file,
      "-scheme",
      src.scheme,
      "-configuration",
      config,
      "-destination",
      `platform=iOS Simulator,id=${sim.udid}`,
      "-derivedDataPath",
      dir,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    { timeout: input.timeoutMs ?? 600_000 },
  );
  const log = await record("build", out);
  const id =
    input.bundleId || (await bundle(src.flag, src.file, src.scheme).catch(() => undefined));
  const prod = ok(out) ? await find(dir, config) : undefined;

  return {
    ok: ok(out),
    source: src,
    simulator: sim,
    derivedDataPath: dir,
    appPath: prod,
    bundleId: id,
    logPath: log,
    code: out.code,
    timedOut: out.timed,
    output: brief(out, 12_000),
  };
}

async function schemesFor(flag: string, file: string): Promise<string[]> {
  const out = await run(["xcodebuild", "-list", "-json", flag, file], {
    timeout: PROJECT_LIST_TIMEOUT_MS,
  });
  if (!ok(out)) return [];
  const raw = JSON.parse(out.stdout) as {
    project?: { schemes?: string[] };
    workspace?: { schemes?: string[] };
  };
  return raw.project?.schemes ?? raw.workspace?.schemes ?? [];
}

export async function runApp(input: RunApp = {}) {
  const built = await app({ ...input, openSimulator: input.openSimulator ?? true });
  if (!built.ok) return { ...built, installed: false, launched: false };
  if (!built.appPath)
    throw new Error("Build succeeded, but no .app product was found in DerivedData.");
  if (!built.bundleId)
    throw new Error("Build succeeded, but PRODUCT_BUNDLE_IDENTIFIER could not be resolved.");

  const installed = await install(built.simulator.udid, built.appPath);
  const launched = await launch(built.simulator.udid, built.bundleId, input.launchArgs ?? []);
  return { ...built, installed, launched };
}

async function record(name: string, out: Run): Promise<string> {
  const dir = await data("logs");
  const file = path.join(dir, `${stamp()}-${name}.log`);
  await writeFile(
    file,
    [
      `$ ${out.cmd.join(" ")}`,
      `exit=${out.code}`,
      `timedOut=${out.timed}`,
      "",
      out.stdout,
      out.stderr,
    ].join("\n"),
    "utf8",
  );
  return rel(file);
}

async function find(dir: string, config: string): Promise<string | undefined> {
  return pickAppProduct(await apps(dir, 8), config);
}

export function pickAppProduct(hits: string[], config: string): string | undefined {
  return (
    hits.find((item) => item.includes(`${path.sep}${config}-iphonesimulator${path.sep}`)) ||
    hits.find((item) => item.includes(`${path.sep}Debug-iphonesimulator${path.sep}`)) ||
    hits[0]
  );
}

async function apps(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      items.map(async (item) => {
        const file = path.join(dir, item.name);
        if (item.isDirectory() && item.name.endsWith(".app")) return [file];
        if (item.isDirectory()) return apps(file, depth - 1);
        return [];
      }),
    )
  ).flat();
}

function key(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}
