// 只改变新测试 Host 的系统时间；performance.now 和真实定时器保持不变。
const { appendFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const origin = process.env.ZCODE_E2E_OAUTH_RACE_URL;
const caseId = process.env.ZCODE_E2E_OAUTH_CLOCK_CASE;
let offset = 0;
Date.now = () => originalNow() + offset;
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === origin && url.pathname === "/api/v1/oauth/cli/poll/e2e-race") {
    const value = response.headers.get("x-e2e-clock-offset-ms");
    if (value !== null) {
      offset = Number(value);
      await appendFile(
        join(process.env.ZCODE_E2E_HOST_FAULT_ROOT, `host-boundary-${process.pid}.jsonl`),
        JSON.stringify({ pid: process.pid, id: caseId, kind: "clock-shift", offset }) + "\n",
      );
    }
  }
  return response;
};
async function start() {
  await appendFile(
    join(process.env.ZCODE_E2E_HOST_FAULT_ROOT, `host-boundary-${process.pid}.jsonl`),
    JSON.stringify({ pid: process.pid, id: caseId, kind: "ready" }) + "\n",
  );
  await import(pathToFileURL(process.argv[2]).href);
}
void start();
