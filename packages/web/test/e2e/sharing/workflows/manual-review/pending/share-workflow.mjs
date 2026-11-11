// SHARE-WF01：先启动 pnpm dev:web-share:test；API 由本测试拦截，不访问真实分享或账号。
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const fixtures = JSON.parse(
  await readFile(resolve("packages/services/test/fixtures/workflow-displays.json"), "utf8"),
);
const baseUrl = process.env.SHARE_E2E_BASE_URL || "http://localhost:5173";
const artifacts = process.env.SHARE_E2E_ARTIFACTS || "/tmp/share-workflow-e2e";
await mkdir(artifacts, { recursive: true });
const names = [
  "CreateWorkflow",
  "GetWorkflowRun",
  "ListWorkflowRuns",
  "EvalWorkflowSnippet",
  "ListSavedWorkflows",
  "ListModels",
  "ResumeWorkflowRun",
];
const base = { turnId: "share-turn-1", productTurnId: "share-product-turn-1", createdAt: 1 };
const rows = [
  {
    ...base,
    rowId: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  },
  {
    ...base,
    rowId: 2,
    createdAtSeq: 2,
    kind: "userInput",
    origin: "realUser",
    text: "SHARE-WF01 workflow snapshot",
  },
  ...fixtures.map((display, index) => ({
    ...base,
    rowId: index + 3,
    createdAtSeq: index + 3,
    kind: "toolCall",
    toolCallId: `wf-${index}`,
    toolName: names[index],
    status: "success",
    inputText: "{}",
    input: { name: "调研工作流" },
    output: { text: "Workflow output preserved" },
    display,
  })),
  {
    ...base,
    rowId: 10,
    createdAtSeq: 10,
    kind: "toolCall",
    toolCallId: "wf-failed",
    toolName: "CreateWorkflow",
    status: "success",
    inputText: "{}",
    display: {
      kind: "create_workflow",
      ok: false,
      errorCount: 1,
      diagnostics: [{ line: 2, column: 1, code: 100, message: "WF_COMPILE_DIAGNOSTIC" }],
    },
  },
  {
    ...base,
    rowId: 11,
    createdAtSeq: 11,
    kind: "toolCall",
    toolCallId: "wf-legacy",
    toolName: "CreateWorkflow",
    status: "success",
    inputText: "{}",
    output: { text: "WF_LEGACY_OUTPUT" },
  },
];
// 构造符合真实图语义的最小静态阶段，其他完整字段在两端契约测试中覆盖。
rows[2].display.diagnostics = [];
rows[2].display.causalityGraph.handoffs = [];
rows[2].display.causalityGraph.phaseEdges = [];
delete rows[2].display.causalityGraph.phases[0].alongside;
const preview = {
  schema_version: 1,
  share: {
    title: "Workflow share",
    access_mode: "public_readonly",
    created_at: 1,
    expires_at: 9999999999999,
  },
  rows,
  artifacts: [],
  integrity: { projection_sha256: "a".repeat(64), artifact_set_sha256: "b".repeat(64) },
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const locale of ["cn/share", "share"]) {
    for (const width of [375, 1280]) {
      for (const theme of ["zai-light", "zai-dark"]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.addInitScript((theme) => localStorage.setItem("zcode-theme", theme), theme);
        const page = await context.newPage();
        const errors = [];
        const unexpected = [];
        let previews = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", async (route) => {
          const request = route.request();
          if (new URL(request.url()).pathname.endsWith("/shares/workflow-e2e/preview")) {
            previews++;
            assert.equal(request.method(), "GET");
            return route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({ code: 0, msg: "", data: preview }),
            });
          }
          if (new URL(request.url()).origin === new URL(baseUrl).origin) return route.continue();
          unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`);
          return route.abort();
        });
        await page.goto(`${baseUrl}/${locale}/workflow-e2e`);
        await page
          .locator('[data-conversation-share-workflow="create_workflow"]')
          .first()
          .waitFor();
        for (const kind of [
          "create_workflow",
          "get_workflow_run",
          "list_workflow_runs",
          "eval_workflow_snippet",
          "saved_workflow_list",
          "resume_workflow_run",
        ]) {
          assert.ok(
            await page.locator(`[data-conversation-share-workflow="${kind}"]`).count(),
            kind,
          );
        }
        await page
          .locator('[data-conversation-share-workflow="create_workflow"]')
          .first()
          .screenshot({
            animations: "disabled",
            path: resolve(artifacts, `graph-${locale.replace("/", "-")}-${width}-${theme}.png`),
          });
        assert.ok(
          await page
            .getByTestId("workflow-card-name")
            .first()
            .evaluate((element) => element.getBoundingClientRect().width >= 80),
          "窄屏仍须显示工作流名称",
        );
        // 展开工具卡详情，验证诊断、结果与历史兜底都可读。
        for (const id of ["wf-1", "wf-2", "wf-3", "wf-4", "wf-6", "wf-failed", "wf-legacy"]) {
          const trigger = page.getByTestId(`tool-summary-trigger-${id}`);
          await trigger.click();
        }
        await page.getByText("WF_COMPILE_DIAGNOSTIC", { exact: false }).waitFor();
        await page.getByText("WF_LEGACY_OUTPUT", { exact: false }).waitFor();
        await page.getByTestId("workflow-run-summary-line").waitFor();
        assert.ok(await page.getByText("调研工作流", { exact: false }).count());
        assert.equal(await page.locator('[data-testid="workflow-card-resume"]').count(), 0);
        assert.equal(await page.locator('a[href^="file:"],a[href^="zcode:"]').count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        assert.equal(previews, 1);
        await page.screenshot({
          path: resolve(artifacts, `${locale.replace("/", "-")}-${width}-${theme}.png`),
          fullPage: true,
        });
        await context.close();
        console.log(`PASS SHARE-WF01 ${locale} ${width} ${theme}`);
      }
    }
  }
} finally {
  await browser.close();
}
