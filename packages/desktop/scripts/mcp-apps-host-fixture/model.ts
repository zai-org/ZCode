import { createServer } from "node:http";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Events } from "./agent.js";
// 确定性本地模型只返回预置工具调用；授权、认领、执行、取消仍走真实 Agent。
export async function startModel(root: string, cli: string) {
  const readiness = JSON.parse(await readFile(join(root, "session-ready-provider.json"), "utf8"))
    .fixtures[0];
  const requests = new Events<any>();
  const plans: {
    key: string;
    delayed: boolean;
    holdStream?: boolean;
    toolName?: string;
    arguments?: Record<string, unknown>;
    status?: number;
    finishReason?: string;
  }[] = [];
  const aborted = new Events<string>();
  const releases = new Map<string, () => void>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const plan = plans.shift();
    const tool = body.tools?.find((t: any) =>
      t.function?.name.endsWith(`__${plan?.toolName ?? "page_edit"}`),
    );
    if (!body.stream) {
      const reply = () => {
        releases.delete(plan?.key ?? "");
        if (res.destroyed) return;
        if (plan?.status) {
          res.writeHead(plan.status, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "fixture provider denied",
                type: "authentication_error",
                code: "invalid_api_key",
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "sampling-fixture",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `answer:${plan?.key ?? "sample"}` },
                finish_reason: plan?.finishReason ?? "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      };
      res.on("close", () => {
        if (!res.writableEnded) aborted.emit(plan?.key ?? "sample");
        releases.delete(plan?.key ?? "");
      });
      if (plan?.delayed) releases.set(plan.key, reply);
      requests.emit({ body, plan, tool, url: req.url });
      if (!plan?.delayed) reply();
      return;
    }
    requests.emit({ body, plan, tool, url: req.url });
    if (plan?.holdStream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": fixture running\n\n");
      releases.set(plan.key, () => res.end("data: [DONE]\n\n"));
      res.on("close", () => releases.delete(plan.key));
      return;
    }
    const delta =
      plan && tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${plan.key}`,
                type: "function",
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify(plan.arguments ?? plan),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: readiness.match.bodyIncludes.every((marker: string) =>
              JSON.stringify(body).includes(marker),
            )
              ? readiness.response.text.text
              : "fixture complete",
          };
    const base = {
      id: "fixture-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: plan && tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const builtin = join(root, "fixture-builtin.json"),
    personal = join(root, "fixture-personal.json");
  await copyFile(resolve(cli, "../../../../../../config/provider/zcode-builtin.json"), builtin);
  await writeFile(
    personal,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "fixture-local",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "fixture-only" },
                api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
                personalModelIds: ["gpt-4o", "gpt-4o-mini"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: ["gpt-4o", "gpt-4o-mini"].map((modelId) => ({
            providerId: "fixture-local",
            modelId,
            config: { properties: { inputFormat: { supportsImage: true } } },
          })),
          manualProviderModelRules: [],
        },
        defaultModelSelection: {
          providerId: "fixture-local",
          modelId: "gpt-4o",
          options: { reasoningLevel: "disabled" },
        },
      },
    }),
  );
  return {
    requests,
    plans,
    aborted,
    release: (key: string) => releases.get(key)?.(),
    env: {
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    },
    selection: {
      providerId: "fixture-local",
      modelId: "gpt-4o",
      options: { reasoningLevel: "disabled" },
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
