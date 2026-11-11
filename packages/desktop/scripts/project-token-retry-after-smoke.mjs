import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";

// 真实 HTTP -> ApiClient -> readApiJson -> Host adapter -> shared owner；不替换其中任何解析层。
// 移除响应头的变异模式用于证明用例确实能发现 Host 白名单退化，不修改仓库文件。
const desktopDir = resolve(import.meta.dirname, "..");
await mkdir(resolve(desktopDir, ".e2e-artifacts"), { recursive: true });
const artifact = await mkdtemp(resolve(desktopDir, ".e2e-artifacts/pat-retry-after-"));
const omitHeader = process.argv.includes("--omit-retry-after-header");
const entry = resolve(artifact, "probe.mjs");
async function runFixture(resultPath) {
  const { createServer } = await import("node:http");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile } = await import("node:fs/promises");
  const { createAccountProjectTokenClient } =
    await import("../services/src/model-provider/accountProjectTokenClient.ts");
  const results = [];
  let requests = [],
    scenario = "";
  const server = createServer((req, res) => {
    requests.push(performance.now());
    const attempt = requests.length;
    res.setHeader("content-type", "application/json");
    if (scenario === "long" || attempt === 1) {
      res.statusCode = 429;
      if (scenario === "long") res.setHeader("Retry-After", "60");
      else if (scenario === "one") res.setHeader("rEtRy-AfTeR", "1");
      else if (scenario === "fraction") res.setHeader("Retry-After", "0.5");
      else if (scenario === "date")
        res.setHeader("Retry-After", new Date(Date.now() + 1000).toUTCString());
      else if (scenario === "invalid") res.setHeader("Retry-After", "invalid");
      res.end(JSON.stringify({ code: 429 }));
    } else
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            accessToken: "synthetic-pat",
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: Date.now() / 1000 + 600,
          },
        }),
      );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    for (scenario of ["long", "one", "fraction", "date", "invalid", "absent"]) {
      requests = [];
      const origin = "http://127.0.0.1:" + server.address().port;
      const client = createAccountProjectTokenClient(
        { request: (url, init) => fetch(url, init) },
        {
          load: async () =>
            JSON.stringify({
              organizationId: "org-fixture",
              projectId: "project-fixture",
              apiKeyId: "key-fixture",
            }),
          save: async () => {},
          delete: async () => {},
        },
      );
      let code,
        enabled = false;
      try {
        enabled =
          (
            await client.resolve({
              origin,
              family: "bigmodel",
              accountId: "account-fixture",
              loginToken: "synthetic-login",
              team: null,
            })
          ).token === "synthetic-pat";
      } catch (error) {
        code = error.message;
      }
      const row = {
        scenario,
        requests: requests.length,
        gap: requests.length > 1 ? requests[1] - requests[0] : null,
        enabled,
        code,
      };
      results.push(row);
      await writeFile(resultPath, JSON.stringify(results, null, 2));
      if (scenario === "long") {
        assert.equal(requests.length, 1, "Retry-After 60 不得提前重试");
        assert.equal(code, "project_token_http_429");
      } else {
        assert.equal(requests.length, 2);
        assert.equal(enabled, true);
        assert(
          row.gap >= (scenario === "one" ? 980 : scenario === "fraction" ? 480 : 230),
          scenario + " 等待过短",
        );
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  console.log(JSON.stringify({ passed: results.length, results }));
}

await build({
  stdin: {
    resolveDir: desktopDir,
    contents:
      "(" +
      runFixture.toString() +
      ")(" +
      JSON.stringify(resolve(artifact, "result.json")) +
      ").catch(error => { console.error(error); process.exitCode = 1; });",
  },
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  plugins: [
    {
      name: "workspace-and-header-mutation",
      setup(api) {
        api.onResolve({ filter: /^@zcode\/model-option-map$/ }, () => ({
          path: resolve(desktopDir, "../model-option-map/src/index.ts"),
        }));
        api.onResolve({ filter: /^@zcode\/shared$/ }, () => ({
          path: resolve(desktopDir, "../shared/src/index.ts"),
        }));
        // shared 重新导出会话控制契约；它是工作区源码，不能留给独立 probe.mjs 外部解析。
        api.onResolve({ filter: /^@zcode\/session-control\/contracts$/ }, () => ({
          path: resolve(desktopDir, "../session-control/src/contract.ts"),
        }));
        if (omitHeader)
          api.onLoad({ filter: /\/providers\/api\/apiJson\.ts$/ }, async ({ path }) => ({
            contents: (await readFile(path, "utf8")).replace('  "retry-after",', ""),
            loader: "ts",
          }));
      },
    },
  ],
});
const result = await new Promise((done, reject) => {
  const child = spawn(process.execPath, [entry], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", done);
});
console.log("PAT_RETRY_AFTER_ARTIFACT", artifact);
process.exitCode = result ?? 1;
