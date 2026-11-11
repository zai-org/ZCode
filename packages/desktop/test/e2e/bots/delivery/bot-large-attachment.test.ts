import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import type { IZCodeTaskService } from "@zcode/services";
import {
  createBotsServiceHarness,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";

type Prompt = Parameters<IZCodeTaskService["sendPrompt"]>[0];
type GroupInput = Parameters<NonNullable<IZCodeTaskService["submitBotGroupInput"]>>[0];

describe("BOT-E2E-AT-01 large Bot attachments", () => {
  for (const provider of ["feishu", "lark"] as const) {
    for (const chatType of ["p2p", "group"] as const) {
      for (const scenario of [
        { type: "file", mib: 6 },
        { type: "post", mib: 3 },
        { type: "post", mib: 6 },
      ] as const) {
        it(`${provider}/${chatType}/${scenario.type}: caches and submits a ${scenario.mib} MiB file, still rejects download failure`, async () => {
          const fixture = await readBotSyntheticFixture("large-attachment.json");
          assert.equal(fixture.classification, "synthetic");
          const bytes = Buffer.alloc(scenario.mib * 1024 * 1024, "x");
          bytes.write(fixture.promptMarker!);
          const filename = `${fixture.promptMarker}.txt`;
          const requests: RecordedRequest[] = [];
          const downloads: string[] = [];
          const originalFetch = globalThis.fetch;
          const recordingFetch = createRecordingFeishuFetch(requests);
          let downloadStatus = 503;
          globalThis.fetch = async (input, init) => {
            const url = String(input);
            if (url.includes("/resources/file_large")) {
              downloads.push(url);
              return new Response(bytes, { status: downloadStatus });
            }
            if (url.endsWith("/bot/v3/info"))
              return Response.json({ code: 0, bot: { open_id: "ou_current_bot" } });
            if (url.includes("/im/v1/chats/"))
              return Response.json({ code: 0, data: { name: "E2E Group", chat_mode: "group" } });
            return recordingFetch(input, init);
          };
          const botId = `${provider}-${chatType}-large-attachment`;
          const h = createBotsServiceHarness({ config: createFeishuConfig(provider, botId) });
          const prompts: Prompt[] = [];
          const groupInputs: GroupInput[] = [];
          h.zcodeTaskService.sendPrompt = async (params: Prompt) => {
            prompts.push(params);
          };
          h.zcodeTaskService.submitBotGroupInput = async (params: GroupInput) => {
            groupInputs.push(params);
            return {
              commandId: params.commandId,
              status: "accepted",
              revisionAtDecision: 1,
              result: { type: "inputAccepted", inputId: params.commandId, delivery: "startNow" },
            };
          };
          const callback = (messageId: string, messageType: "text" | "file" | "post") => ({
            botId,
            event: {
              sender: { sender_type: "user", sender_id: { open_id: "ou_e2e_user" } },
              message: {
                chat_type: chatType,
                chat_id: "oc_large_attachment",
                message_id: messageId,
                message_type: messageType,
                content: JSON.stringify(
                  messageType === "file"
                    ? { file_key: "file_large", file_name: filename }
                    : messageType === "post"
                      ? {
                          title: "",
                          content: [[{ tag: "text", text: fixture.promptMarker }]],
                          files: [
                            { file_key: "file_large", file_name: filename, size: bytes.length },
                          ],
                        }
                      : { text: "@_user_1 /enable" },
                ),
                mentions: [{ key: "@_user_1", id: { open_id: "ou_current_bot" }, name: "E2E Bot" }],
              },
            },
          });
          let cachedPath: string | undefined;
          try {
            if (chatType === "group") {
              await h.service.handleProviderCallbackResponse(
                provider,
                callback("om_enable", "text"),
              );
            }
            const failureStart = requests.length;
            await h.service.handleProviderCallbackResponse(
              provider,
              callback("om_unavailable", scenario.type),
            );
            assert.equal(downloads.length, 1);
            assert.equal(prompts.length + groupInputs.length, 0);
            assert.match(
              JSON.stringify(requests.slice(failureStart)),
              /无法下载附件|download failed/u,
            );
            requests.length = 0;
            downloadStatus = 200;
            await h.service.handleProviderCallbackResponse(
              provider,
              callback("om_large", scenario.type),
            );
            assert.equal(prompts.length + groupInputs.length, 1, JSON.stringify(requests));
            if (scenario.type === "post") {
              assert.ok((prompts[0] ?? groupInputs[0])?.content.includes(fixture.promptMarker!));
            }
            assert.equal(downloads.length, 2);
            assert.equal(
              new URL(downloads[0]!).hostname,
              provider === "feishu" ? "open.feishu.cn" : "open.larksuite.com",
            );
            if (chatType === "group") {
              const attachment = groupInputs[0]?.attachments?.[0];
              assert.ok(attachment);
              assert.equal(attachment.kind, "file");
              assert.equal(attachment.filename, filename);
              assert.equal(attachment.sizeBytes, bytes.length);
              assert.ok(attachment.dataBase64);
              assert.deepEqual(Buffer.from(attachment.dataBase64, "base64"), bytes);
              cachedPath = attachment.localPath;
            } else {
              assert.equal(groupInputs.length, 0);
              cachedPath = prompts[0]?.content.match(/已保存到：([^\n]+)/u)?.[1];
              assert.ok(prompts[0]?.content.includes(filename));
            }
            assert.ok(cachedPath);
            assert.deepEqual(await readFile(cachedPath), bytes);
            assert.equal(JSON.stringify(requests).includes("附件处理失败"), false);
          } finally {
            await h.service.disposeAllAndWait();
            globalThis.fetch = originalFetch;
            if (cachedPath) await rm(cachedPath, { force: true });
          }
        });
      }
    }
  }
});
