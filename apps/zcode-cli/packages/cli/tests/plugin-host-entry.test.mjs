import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  createZodDedupePlugin,
  readZodBuildVersion,
  resolveBuildAliases,
  resolveBuildExternal,
} from "../scripts/build.mjs";

const execFileAsync = promisify(execFile);
const cliRoot = resolve(import.meta.dirname, "..");
const forbiddenEvaluation = "AGENT_ENTRY_EVALUATED";
const processTimeoutMs = 10_000;

for (const minify of [false, true]) {
  test(`plugin host avoids Agent initialization in ${minify ? "desktop" : "Node"} bundles`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-entry-"));
    const outfile = join(directory, "zcode.cjs");
    const serverPath = join(directory, "server.mjs");
    const blockedModules = new Set([
      resolve(cliRoot, "src/run.ts"),
      resolve(cliRoot, "src/provider-runtime-env.ts"),
      resolve(cliRoot, "../core/dist/runtime.js"),
      resolve(cliRoot, "../contracts/dist/index.js"),
      resolve(cliRoot, "../../../../packages/shared/src/index.ts"),
    ]);

    try {
      await writeFile(
        serverPath,
        `const socketVisibleAtImport = process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET !== undefined;
const processTitleAtImport = process.title;
export async function main() {
  process.stdout.write(JSON.stringify({
    processTitleAtImport,
    processTitle: process.title,
    args: process.argv.slice(2),
    nodeEnvRemoved: process.env.NODE_ENV === undefined,
    socketVisibleAtImport,
    socketVisibleAtMain: process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET !== undefined,
    tokenVisibleAtMain: process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN !== undefined,
  }));
}`,
      );
      await build({
        alias: resolveBuildAliases(),
        bundle: true,
        entryPoints: [join(cliRoot, "src/main.ts")],
        external: resolveBuildExternal(),
        format: "cjs",
        keepNames: minify,
        minify,
        metafile: true,
        outfile,
        platform: "node",
        target: "node22",
        plugins: [
          createZodDedupePlugin({ expectedV4Version: await readZodBuildVersion() }),
          {
            name: "reject-agent-initialization",
            setup(builder) {
              builder.onLoad({ filter: /\.[jt]s$/ }, async ({ path }) => {
                if (!blockedModules.has(path)) return undefined;
                // 回归要挡住模块求值，而非只看包大小；构建仍保留普通 CLI 所需代码。
                return {
                  contents: `throw new Error(${JSON.stringify(forbiddenEvaluation)});\n${await readFile(path, "utf8")}`,
                  loader: path.endsWith(".ts") ? "ts" : "js",
                };
              });
            },
          },
        ],
      });

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [outfile, "__zcode-plugin-host", serverPath, "--prompt", "plugin argument"],
        {
          env: { ...process.env, NODE_ENV: "untrusted", ZCODE_PLUGIN_ID: "" },
          timeout: processTimeoutMs,
        },
      );
      assert.equal(stderr, "");
      assert.deepEqual(JSON.parse(stdout), {
        processTitleAtImport: "zcode-mcp",
        processTitle: "zcode-mcp",
        args: ["--prompt", "plugin argument"],
        nodeEnvRemoved: true,
        socketVisibleAtImport: false,
        socketVisibleAtMain: false,
        tokenVisibleAtMain: false,
      });

      for (const [pluginId, expectedTitle] of [
        ["documents@zcode-plugins-official", "zcode-mcp-documents"],
        [" ZCode-Site@example-marketplace ", "zcode-mcp-zcode-site"],
        ["invalid/name@example-marketplace", "zcode-mcp"],
      ]) {
        const named = await execFileAsync(
          process.execPath,
          [outfile, "__zcode-plugin-host", serverPath],
          {
            env: { ...process.env, ZCODE_PLUGIN_ID: pluginId },
            timeout: processTimeoutMs,
          },
        );
        assert.equal(named.stderr, "");
        const payload = JSON.parse(named.stdout);
        assert.equal(payload.processTitleAtImport, expectedTitle);
        assert.equal(payload.processTitle, expectedTitle);
      }

      const brokerSocket = join(directory, "broker.sock");
      const authorizedEnv = {
        ...process.env,
        NODE_ENV: "untrusted",
        ZCODE_PLUGIN_ID: "computer-use@zcode-plugins-official",
        ZCODE_CUA_PERMISSION_BROKER_SOCKET: brokerSocket,
        ZCODE_CUA_PERMISSION_BROKER_TOKEN: "test-scoped-token",
        ZCODE_CUA_PLUGIN_AUTHORITY: "test-official-authority",
        // broker 已改身份模式（Helper 按对端代码签名裁决连接），凭据组只剩 socket +
        // pluginAuthority；captured 凭据只允许启动 shared node_repl 宿主，由这个标记声明。
        ZCODE_CUA_NODE_REPL_HOST: "1",
      };
      const authorized = await execFileAsync(
        process.execPath,
        [outfile, "__zcode-plugin-host", serverPath, "--permission-broker-socket", brokerSocket],
        { env: authorizedEnv, timeout: processTimeoutMs },
      );
      assert.equal(authorized.stderr, "");
      assert.deepEqual(JSON.parse(authorized.stdout), {
        processTitleAtImport: "zcode-mcp-computer-use",
        processTitle: "zcode-mcp-computer-use",
        args: ["--permission-broker-socket", brokerSocket],
        nodeEnvRemoved: true,
        // socket 被 sanitize 收进 capture，插件模块求值时读不到；只有 plugin host 在
        // 确认是可信 node_repl 宿主后才恢复到 env，供 broker bridge 读取。
        socketVisibleAtImport: false,
        socketVisibleAtMain: true,
        // token 已从凭据组删除，宿主不再恢复它。
        tokenVisibleAtMain: false,
      });

      // 非 node_repl 宿主必须在插件 import 前被拒绝，不能因入口提前分流绕过产品鉴权。
      // 旧契约比对 argv 上的 socket 值，身份模式下改为要求宿主标记；拦截时机的要求不变。
      await writeFile(serverPath, 'throw new Error("UNAUTHORIZED_PLUGIN_IMPORTED");');
      const { ZCODE_CUA_NODE_REPL_HOST: _hostMarker, ...unauthorizedEnv } = authorizedEnv;
      await assert.rejects(
        execFileAsync(
          process.execPath,
          [outfile, "__zcode-plugin-host", serverPath, "--permission-broker-socket", brokerSocket],
          { env: unauthorizedEnv, timeout: processTimeoutMs },
        ),
        (error) =>
          error.stdout === "" &&
          error.stderr.includes("Captured ZCode CUA broker credentials may only launch") &&
          !error.stderr.includes("UNAUTHORIZED_PLUGIN_IMPORTED"),
      );

      // 证明探针实际生效：普通命令仍进入业务分支，触发被注入的求值错误。
      await assert.rejects(
        execFileAsync(process.execPath, [outfile, "--version"], { timeout: processTimeoutMs }),
        (error) => error.stderr.includes(forbiddenEvaluation),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}
