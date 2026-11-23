import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  PdfDocumentPortError,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type FileSystemPort,
  type ImageProcessorPort,
  type PdfDocumentPort,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { type AgentRuntime } from "../src/runtime.js";
import { createTurnModel } from "../src/runtime/methods/turn-model.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory, createTestRuntimeModel } from "./test-runtime-model.js";

describe("Read PDF executor schema", () => {
  it("keeps the 120-second Poppler timeout inside a 150-second PDF tool budget", () => {
    const input = { file_path: "/tmp/report.pdf", pages: "1" };

    expect(
      readToolEntry.resolveTimeoutBudgetMs?.(input, {
        model: modelWith({ supportsPdf: true }),
      }),
    ).toBe(150_000);
    expect(
      readToolEntry.resolveTimeoutBudgetMs?.(input, {
        model: modelWith({ supportsPdf: false }),
      }),
    ).toBeUndefined();
  });

  it("projects the PDF schema and description from the same model capability snapshot", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("read-pdf-tool-shape"),
      {},
      { eventStore: createTestSessionEventStore() },
    );
    const supported = readTool(runtime, { supportsPdf: true, supportsImages: true });
    const unsupported = readTool(runtime, { supportsPdf: false, supportsImages: true });

    // PDF 句接在图片行末尾，同一行。
    expect(supported.description.split("\n")).toContain(
      '- Reads images (PNG, JPG, …) and presents them visually. Reads PDFs via the `pages` parameter (e.g. "1-5", max 20 pages/request; required for PDFs over 10 pages).',
    );
    expect(supported.inputSchema.properties).toHaveProperty("pages");
    expect(unsupported.description).not.toContain("Reads PDFs via the `pages` parameter");
    expect(unsupported.inputSchema.properties).not.toHaveProperty("pages");
  });

  it("uses the same capability-matched pages schema as the provider tool shape", async () => {
    const renderPages = vi.fn(async () => [
      {
        pageNumber: 1,
        data: new Uint8Array(Buffer.from("page-one")),
        mediaType: "image/jpeg" as const,
      },
    ]);
    const supported = await execute({ supportsPdf: true, supportsImages: true }, { renderPages });
    expect(supported.success).toBe(true);
    expect(renderPages).toHaveBeenCalledTimes(1);

    const unsupported = await execute(
      { supportsPdf: false, supportsImages: true },
      { renderPages },
    );
    expect(unsupported.success).toBe(false);
    expect(renderPages).toHaveBeenCalledTimes(1);
  });

  it("classifies adapter-side PDF cancellation through the executor", async () => {
    const result = await execute(
      { supportsPdf: true, supportsImages: true },
      {
        renderPages: async () => {
          throw new PdfDocumentPortError("cancelled", "PDF extraction cancelled");
        },
      },
    );

    expect(result).toMatchObject({
      error: {
        type: CoreErrorType.ToolCancelled,
      },
      success: false,
    });
  });

  it.each([
    {
      errorCode: 7,
      message:
        'Invalid pages parameter: "invalid". Give one page ("3") or one range ("1-5"), not a list. To read several pages or ranges, read each one separately. Pages are 1-indexed.',
      pages: "invalid",
    },
    {
      errorCode: 8,
      message:
        'Page range "1-21" exceeds maximum of 20 pages per request. Please use a smaller range.',
      pages: "1-21",
    },
  ])(
    "rejects PDF pages with error $errorCode before hooks, permission, and I/O",
    async ({ errorCode, message, pages }) => {
      const renderPages = vi.fn();
      const stat = vi.fn();
      const hookRun = vi.fn(async () => ({ additionalContexts: [] }));
      const permissionService = new PermissionService(defaultPermissionConfig);
      const permissionCheck = vi.spyOn(permissionService, "checkPermission");

      const result = await execute(
        { supportsPdf: true, supportsImages: true },
        { renderPages },
        {
          fileSystemPort: { stat } as unknown as FileSystemPort,
          hookRun,
          input: { file_path: "/tmp/report.pdf", pages },
          permissionService,
        },
      );

      expect(result).toMatchObject({
        error: { code: String(errorCode), message },
        modelContent: `<tool_use_error>${message}</tool_use_error>`,
        success: false,
      });
      expect(hookRun).not.toHaveBeenCalled();
      expect(permissionCheck).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(renderPages).not.toHaveBeenCalled();
    },
  );

  it("projects the PDF-disabled current turn model into the Read tool schema", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("read-pdf-turn-snapshot"),
      {},
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          properties: {
            inputFormat: {
              supportsText: true,
              supportsImage: true,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
          },
        }),
      },
    );
    const turnModel = createTurnModel(runtime as never);
    const read = turnModel
      ? runtime.getTools(turnModel).find((candidate) => candidate.name === "Read")
      : undefined;

    expect(turnModel.properties.inputFormat.supportsPdf).toBe(false);
    expect(read?.inputSchema.properties).not.toHaveProperty("pages");
  });
});

function readTool(
  runtime: AgentRuntime,
  capabilities: { supportsPdf?: boolean; supportsImages?: boolean },
) {
  const tool = runtime
    .getTools(modelWith(capabilities))
    .find((candidate) => candidate.name === "Read");
  if (!tool) throw new Error("Read tool was not registered");
  return tool;
}

function modelWith(capabilities: { supportsPdf?: boolean; supportsImages?: boolean }) {
  return createTestRuntimeModel({
    generateText: async () => ({ finishReason: "stop", text: "", usage: {} }),
    inputFormat: {
      supportsPdf: capabilities.supportsPdf ?? false,
      supportsImage: capabilities.supportsImages ?? false,
    },
    modelId: "pdf-shape-model",
  });
}

async function execute(
  capabilities: { supportsPdf?: boolean; supportsImages?: boolean },
  pdfPort: Partial<PdfDocumentPort>,
  options: {
    fileSystemPort?: FileSystemPort;
    hookRun?: ReturnType<typeof vi.fn>;
    input?: { file_path: string; pages: string };
    permissionService?: PermissionService;
  } = {},
) {
  const sessionId = createSessionId("read-pdf-executor");
  const turnId = createTurnId("read-pdf-executor");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  registry.register(readToolEntry);
  return createToolExecutor({
    emitEvent: async () => {},
    fileSystemPort: options.fileSystemPort ?? fileSystemPort(),
    ...(options.hookRun ? { hookRunner: { run: options.hookRun } } : {}),
    imageProcessorPort: imageProcessorPort(),
    pdfDocumentPort: pdfPort as PdfDocumentPort,
    model: modelWith(capabilities),
    permissionService: options.permissionService ?? new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    traceContext,
    turnId,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  }).execute(
    {
      id: createToolCallId("read-pdf-executor"),
      input: options.input ?? { file_path: "/tmp/report.pdf", pages: "1" },
      name: "Read",
    },
    { traceContext },
  );
}

function fileSystemPort(): FileSystemPort {
  return {
    async stat(request) {
      return { path: request.path, kind: "file", sizeBytes: 10 };
    },
  } as FileSystemPort;
}

function imageProcessorPort(): ImageProcessorPort {
  return {
    async prepareForModel(request) {
      return {
        data: request.data,
        mediaType: request.mediaType,
        originalSizeBytes: request.data.byteLength,
        transformedSizeBytes: request.data.byteLength,
        resized: false,
        compressed: false,
        strategy: "original" as const,
      };
    },
  };
}
