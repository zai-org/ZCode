import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectId, createSessionId } from "@zcode/contracts";
import { MessageHistoryImpl } from "../../core/src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../core/src/agent/session-history-hydrator.js";
import { persistUserPrompt } from "../../core/src/runtime/methods/message-persistence.js";
import type { AgentRuntimeInternal } from "../../core/src/runtime/internal.js";
import { createNodeFileSystemAdapter } from "../src/fs/index.js";
import { createNodeToolArtifactStore, createSqliteSessionStore } from "../src/storage/index.js";

export const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDo0AAAAASUVORK5CYII=";

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "attachment-resume-"));
  const dbPath = join(root, "session.sqlite");
  const sessionId = createSessionId("attachment-resume");
  let store = await createSqliteSessionStore({ dbPath });
  await store.createSession({
    id: sessionId,
    projectID: createProjectId("fixture"),
    slug: "fixture",
    directory: root,
    title: "fixture",
    version: "1",
  });
  await Promise.all([
    writeFile(join(root, "bundle.zip"), "binary fixture"),
    writeFile(join(root, "pasted.txt"), "clipboard text"),
    writeFile(join(root, "notes.md"), "# Notes\nKeep exact text."),
    writeFile(join(root, "local.png"), Buffer.from(png.split(",")[1]!, "base64")),
  ]);
  const artifactStore = createNodeToolArtifactStore({
    rootDir: join(root, "artifacts"),
    imageCacheRootDir: join(root, "images"),
    videoCacheRootDir: join(root, "videos"),
  });
  const history = new MessageHistoryImpl();
  history.init("system fixture");
  const runtime = {
    sessionId,
    sessionStore: store,
    messageHistory: history,
    artifactStore,
    fileSystemPort: createNodeFileSystemAdapter(),
    workingDirectory: root,
    config: { agentName: "fixture", systemPrompt: "system fixture" },
    getTools: () => [],
    getSessionModelSelection: () => undefined,
    persistMessage: (message: Parameters<typeof store.saveMessage>[0]) =>
      store.saveMessage(message),
    persistPart: (part: Parameters<typeof store.savePart>[0]) => store.savePart(part),
  } as unknown as AgentRuntimeInternal;
  runtime.persistUserPrompt = persistUserPrompt.bind(runtime);
  return {
    root,
    runtime,
    history,
    artifactStore,
    async cold() {
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const messages = await store.messages({ sessionID: sessionId });
      const cold = new MessageHistoryImpl();
      cold.init("system fixture");
      await hydrateMessageHistoryFromSession({ history: cold, messages, artifactStore });
      return { history: cold, messages };
    },
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
