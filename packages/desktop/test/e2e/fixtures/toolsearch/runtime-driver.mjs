import {
  createZCodeApp,
  startProcessProviderRegistryRuntime,
} from "../../../../../../apps/zcode-cli/packages/bootstrap/dist/index.js";

// 当前产品不提供 MCP 热更新。此 driver 只用于 Runtime/Adapter HTTP 集成测试：
// 注入目录变化，不替换模型 adapter、compact、持久化或公告逻辑，不计为 MCP 用户流程 E2E。
const providers = await startProcessProviderRegistryRuntime(process.env);
const options = JSON.parse(process.argv[3] ?? "{}");
const recordingTool = "mcp__catalog__lookup";
const recordedRequests = [];
const app = await createZCodeApp({
  providerRegistry: providers.runtime.registryService,
  configuredDefaultModelSelection: providers.configuredDefaultModelSelection,
  env: process.env,
  // 已结束 turn 的内存事件会裁掉 messages；在真实事件到达时取证，不能事后把统计当正文。
  eventSink: {
    onSessionEvent(event) {
      if (event.type === "model_request") recordedRequests.push(structuredClone(event.payload));
    },
  },
  runtimeConfig: {
    workingDirectory: process.cwd(),
    toolSearch: { mode: options.mode ?? "native" },
    modelStreaming: process.argv[2] ?? "on",
    titleGeneration: { enabled: false },
    toolAllowlist: [
      "Read",
      "ToolSearch",
      "TaskOutput",
      "TodoRead",
      "DeferredToolCall",
      ...(options.recording ? [recordingTool] : []),
    ],
    ...(options.autoCompact
      ? { compact: { contextWindow: 40000, bufferTokens: 10, summaryReserveTokens: 0 } }
      : {}),
  },
});
// 首次用户执行会初始化 shell 并重建内置工具；先完成该边界，再注入目录场景。
await app.runtime.ensureSessionPersistedForExternalActivity("E2E_TOOLSEARCH_CATALOG_SETUP");
await app.resume();
const registry = app.runtime.getToolRegistry();
const original = new Map(registry.list().map((name) => [name, registry.get(name)]));
process.on("message", async ({ id, command, name, state, prompt }) => {
  try {
    let value;
    if (command === "catalog") {
      if (state === "absent") registry.unregister(name);
      else {
        const entry = original.get(name);
        if (!entry) throw new Error(`Unknown test tool: ${name}`);
        registry.register(
          { ...entry, metadata: { ...entry.metadata, alwaysLoad: state === "resident" } },
          { silentDuplicateWarning: true },
        );
      }
      app.runtime.invalidateToolCache();
    } else if (command === "turn") {
      await app.submitPrompt(prompt);
    } else if (command === "history") {
      value = app.runtime.messageHistory.toRuntimeEntries();
    } else if (command === "records") {
      value = recordedRequests;
    } else if (command === "close") {
      await app.close();
      providers.dispose();
      process.send({ id, value });
      process.disconnect();
      return;
    } else throw new Error(`Unknown driver command: ${command}`);
    process.send({ id, value });
  } catch (error) {
    process.send({ id, error: error.stack ?? String(error) });
  }
});
process.send({ ready: true });
