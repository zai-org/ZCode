import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createPdfProviderFixture } from "./helpers/pdf-provider-fixture.js";
import type { ModelSelection as ModelRef, ProviderRegistry } from "@zcode/provider";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
  createSqliteSessionStore,
} from "@zcode/adapters/storage";
import {
  createModelId,
  createModelProviderId,
  createProjectId,
  createRootTraceContext,
  createSessionId,
  DefaultRuntimeConfig,
  type PdfDocumentPort,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";

import { createSessionFacade } from "../src/app/session-facade.js";

const PROVIDER_ID = createModelProviderId("pdf-switch-capture");
const PDF_CAPABLE_MODEL: ModelRef = {
  providerId: PROVIDER_ID,
  modelId: createModelId("pdf-capable"),
};
const PDF_INCAPABLE_MODEL: ModelRef = {
  providerId: PROVIDER_ID,
  modelId: createModelId("pdf-incapable"),
};
const PDF_BYTES = Buffer.from("%PDF-1.4\nZCode PDF model switch fixture\n%%EOF\n", "ascii");
const PDF_OMITTED_TEXT =
  "Media omitted from provider request because the selected model does not support PDF input.";

describe("Read PDF model capability switching E2E", () => {
  it("omits and restores raw PDF data in final provider requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-read-pdf-model-switch-e2e-"));
    const pdfPath = join(root, "switchable.pdf");
    const sessionId = createSessionId("read-pdf-model-switch-e2e");
    const sessionStore = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
    const capture = await startChatCaptureServer(pdfPath);
    const fixture = createPdfProviderFixture(capture.baseURL, PROVIDER_ID, [
      { modelId: PDF_CAPABLE_MODEL.modelId, supportsPdf: true },
      { modelId: PDF_INCAPABLE_MODEL.modelId, supportsPdf: false },
    ]);
    const runtime = new AgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelSelection: { ...PDF_CAPABLE_MODEL, options: { reasoningLevel: "disabled" } },
        modelStreaming: "off",
        workingDirectory: root,
      },
      {
        artifactStore: createNodeToolArtifactStore({
          imageCacheRootDir: join(root, "image-cache"),
          rootDir: join(root, "artifacts"),
          videoCacheRootDir: join(root, "video-cache"),
        }),
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
        modelFactory: fixture.modelFactory,
        pdfDocumentPort,
        sessionStore,
      },
    );
    const modelSwitcher = createModelSwitcher({
      providerRegistry: fixture.registry,
      root,
      runtime,
      sessionId,
      sessionStore,
    });

    try {
      await writeFile(pdfPath, PDF_BYTES);
      await runtime.executeTurn(`Read ${pdfPath}`);

      expect(capture.bodies).toHaveLength(2);
      expectPdfVisibility(capture.bodies[1]!, PDF_CAPABLE_MODEL, true);

      await modelSwitcher.setModel({
        ...PDF_INCAPABLE_MODEL,
        options: { reasoningLevel: "disabled" },
      });
      await runtime.executeTurn("Continue without PDF support.");

      expect(capture.bodies).toHaveLength(3);
      expectPdfVisibility(capture.bodies[2]!, PDF_INCAPABLE_MODEL, false);

      await modelSwitcher.setModel({
        ...PDF_CAPABLE_MODEL,
        options: { reasoningLevel: "disabled" },
      });
      await runtime.executeTurn("Continue after restoring PDF support.");

      expect(capture.bodies).toHaveLength(4);
      expectPdfVisibility(capture.bodies[3]!, PDF_CAPABLE_MODEL, true);
    } finally {
      runtime.beginShutdown();
      sessionStore.close();
      await closeServer(capture.server);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

const pdfDocumentPort: PdfDocumentPort = {
  async getPageCount() {
    return 1;
  },
  async renderPages() {
    throw new Error("PDF page rendering is not used by the raw PDF model-switch fixture");
  },
};

function createModelSwitcher(input: {
  providerRegistry: ProviderRegistry;
  root: string;
  runtime: AgentRuntime;
  sessionId: ReturnType<typeof createSessionId>;
  sessionStore: Awaited<ReturnType<typeof createSqliteSessionStore>>;
}) {
  return createSessionFacade({
    configResult: {
      config: DefaultRuntimeConfig,
      configPort: {} as never,
      sources: {} as never,
    },
    getConfiguredMcpServers: () => ({}),
    executionPort: {} as never,
    logger: { info() {} } as never,
    loggerFactory: {} as never,
    providerRegistry: input.providerRegistry,
    ownsExecutionPort: false,
    ownsMcpPort: false,
    ownsSessionStore: false,
    prepareResume: async () => {},
    prepareUserExecutionBoundary: async () => {},
    projectID: createProjectId("read-pdf-model-switch-e2e"),
    resolveUiLocale: () => "en-US",
    runtime: input.runtime,
    sessionId: input.sessionId,
    sessionStore: input.sessionStore,
    traceContext: createRootTraceContext({ sessionId: input.sessionId }),
    untrustedProjectMcpServers: new Set(),
    workingDirectory: input.root,
  });
}

async function startChatCaptureServer(pdfPath: string): Promise<{
  baseURL: string;
  bodies: Record<string, unknown>[];
  server: Server;
}> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk.toString();
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    bodies.push(body);
    const firstRequest = bodies.length === 1;
    const requestedModel = typeof body.model === "string" ? body.model : "pdf-model-switch";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: firstRequest ? "tool_calls" : "stop",
            index: 0,
            message: firstRequest
              ? {
                  content: null,
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: JSON.stringify({ file_path: pdfPath }),
                        name: "Read",
                      },
                      id: "read-pdf-model-switch",
                      type: "function",
                    },
                  ],
                }
              : { content: "done", role: "assistant" },
          },
        ],
        created: 0,
        id: `chatcmpl-read-pdf-switch-${bodies.length}`,
        model: requestedModel,
        object: "chat.completion",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server has no port");
  return { baseURL: `http://127.0.0.1:${address.port}`, bodies, server };
}

function expectPdfVisibility(
  body: Record<string, unknown>,
  model: ModelRef,
  visible: boolean,
): void {
  expect(body.model).toBe(String(model.modelId));
  const serialized = JSON.stringify(body);
  const pdfBase64 = PDF_BYTES.toString("base64");
  if (visible) {
    expect(serialized).toContain(pdfBase64);
    expect(serialized).toContain("application/pdf");
    expect(serialized).not.toContain(PDF_OMITTED_TEXT);
    return;
  }
  expect(serialized).not.toContain(pdfBase64);
  expect(serialized).toContain(PDF_OMITTED_TEXT);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
