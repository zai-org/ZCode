import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectBareModuleSpecifiers } from "../src/packaging/stageDependencies.js";
import { SERVER_CLI_DEFINES } from "../tsup.config.js";
import { loadBuiltinProviderConfig } from "../../../scripts/builtin-provider-config.mjs";

describe("server cli tsup config", () => {
  it("embeds the selected environment's Built-in config used by Server Core", async () => {
    const expected = await loadBuiltinProviderConfig();
    expect(JSON.parse(SERVER_CLI_DEFINES.__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__)).toBe(
      expected.content,
    );
  });

  it("embeds the product version and the Source Server compatibility floor", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8"),
    ) as { version: string; zcodeCompatibility?: { minCompatibleVersion?: string } };

    expect(JSON.parse(SERVER_CLI_DEFINES.__ZCODE_VERSION__)).toBe(rootPackageJson.version);
    // 缺少这个 define 时 shared 的 ZCODE_MIN_COMPATIBLE_VERSION 会回退为产品版本，
    // Desktop 与远端 Server 的兼容性判定就失去了独立的下限。
    expect(JSON.parse(SERVER_CLI_DEFINES.__ZCODE_MIN_COMPATIBLE_VERSION__)).toBe(
      rootPackageJson.zcodeCompatibility?.minCompatibleVersion ?? rootPackageJson.version,
    );
  });
});

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const tsupCli = join(dirname(require.resolve("tsup/package.json")), "dist/cli-default.js");

describe("real ESM Server bundle", () => {
  let runtimeDir = "";

  beforeAll(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "zcode-server-bundle-"));
    await execFileAsync(process.execPath, [tsupCli, "--out-dir", runtimeDir, "--silent"], {
      cwd: packageRoot,
      timeout: 25_000,
    });
    await writeFile(join(runtimeDir, "package.json"), '{"type":"module"}\n', "utf8");
    await symlink(
      resolve(packageRoot, "../../node_modules"),
      join(runtimeDir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }, 45_000);

  afterAll(async () => {
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
  });

  it("loads the real ESM Server CLI bundle before handling a version probe", async () => {
    // Bug 原因：源码测试不会经过真实 ESM 打包，模拟发行包也不会加载真实 services。
    // 必须执行实际 ESM 产物，才能捕获间接依赖 yazl 内的 require("fs") 启动崩溃。
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(runtimeDir, "server-cli.js"), "--version", "--json"],
      {
        cwd: runtimeDir,
        // 不继承测试加载器；发行入口需要依靠 Node 自身的模块加载规则启动。
        env: { ...process.env, NODE_OPTIONS: "" },
        timeout: 10_000,
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      product: "zcode-server",
      version: expect.any(String),
    });
  });

  it("keeps the Feishu SDK as a staged runtime dependency of Server Core", async () => {
    // Bug 原因：SDK 内联进 ESM 后，其 CJS 依赖 require Node 内置模块会抛 Dynamic require；
    // esbuild 懒初始化只跑一次，重试拿到半初始化模块，远端飞书长连接报
    // "EventDispatcher is not a constructor"。SDK 必须保留为裸导入，由 staging 随包携带。
    const source = await readFile(join(runtimeDir, "server-core.js"), "utf8");
    expect(source).not.toContain("@larksuiteoapi/node-sdk/es/index.js");
    expect(source).not.toContain("@larksuiteoapi/node-sdk/lib/index.js");
    expect(collectBareModuleSpecifiers(source)).toContain("@larksuiteoapi/node-sdk");
  });
});
