import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E, getV4DraftThoughtState } from "#e2e/helpers/v4-conversation";

describe("C91-04 connectivity whitelist prompt", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("caps the probe at the model output limit and preserves saved selections", async function () {
    this.timeout(120_000);
    const providerId = "e2e-c91-probe";
    const modelId = "E2E_C91_MODEL";
    const bodies: Record<string, unknown>[] = [];
    let reject = false;
    // synthetic / fast-text：固定白名单禁止在 Prompt 中追加 E2E marker，按独立模型 ID 和完整 body 识别。
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      bodies.push(JSON.parse(raw));
      if (reject) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "E2E_C91_REJECTED", type: "invalid_request_error" } }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "e2e-c91",
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })}\n\ndata: ${JSON.stringify({
          id: "e2e-c91",
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          // 输出预算可全部用于推理；无正文的正常 length 结束也必须显示连接成功。
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
          // 省略用量会触发正式 Adapter 的零用量空响应重试，不能代表已消耗 1 Token。
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing probe server address");
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      await restartIntoWorkspace({
        afterElectronProcessExit: () =>
          seedReplayProvider({
            id: providerId,
            name: "E2E C91 Probe",
            apiKey: "e2e-only",
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            // 真实 Model.bind 会拒绝超出上限的预算；验证小容量模型仍能发出探测请求。
            models: [{ id: modelId, maxOutputTokens: 256 }],
          }),
      });
      const paths = getE2EAppDataPaths();
      const beforeConfig = await readFile(paths.configFile, "utf8");
      const connection = async () => {
        const settings = JSON.parse(await readFile(join(paths.appDataDir, "setting.json"), "utf8"));
        return {
          domain: settings.providerFamilyDomain,
          connections: settings.providerFamilyConnectionSelections,
        };
      };
      const beforeConnection = await connection();
      const beforeSelection = await getV4DraftThoughtState(paths.workspace);
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      const probe = () =>
        $(`[data-model-provider-model-id="${modelId}"] button:has(svg.lucide-unplug)`);
      await probe().waitForClickable({ timeout: 15_000 });
      await probe().click();
      await browser.waitUntil(
        async () => {
          const text = await browser.execute(() => document.body.innerText);
          return text.includes("connected") || text.includes("连接成功");
        },
        { timeout: 30_000, timeoutMsg: "Probe success feedback missing" },
      );
      expect(bodies).toHaveLength(1);
      reject = true;
      await probe().waitForClickable({ timeout: 15_000 });
      await probe().click();
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => document.body.innerText)).includes(
            "Provider rejected the model request.",
          ),
        { timeout: 30_000 },
      );
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(body.model).toBe(modelId);
        expect(body.stream).toBe(true);
        expect(body.max_completion_tokens).toBe(256);
        expect(body.messages).toEqual([
          { role: "system", content: "You are ZCode connectivity probe." },
          { role: "user", content: "hi" },
        ]);
        expect(body.tools).toBeUndefined();
      }
      expect(await readFile(paths.configFile, "utf8")).toBe(beforeConfig);
      expect(await connection()).toEqual(beforeConnection);
      expect(await getV4DraftThoughtState(paths.workspace)).toEqual(beforeSelection);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolve())),
      );
    }
  });
});
