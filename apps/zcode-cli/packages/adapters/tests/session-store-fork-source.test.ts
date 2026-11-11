import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  ForkCommitBundle,
  ForkFromSourceInput,
  MessageWithParts,
  SessionInfo,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

const parentId = "source-parent" as never;
const childId = "source-child" as never;
const largeText = "large body ".repeat(100_000);

function bundle(parent: SessionInfo, messages: MessageWithParts[]): ForkCommitBundle {
  const copied = messages.map((message, index) => ({
    info: {
      ...message.info,
      id: `copied-${index}` as never,
      sessionID: childId,
      visibility: "model-only" as const,
      metadata: {
        ...message.info.metadata,
        forkOrigin: { sessionId: parentId, messageId: message.info.id },
      },
    },
    parts: message.parts.map((part, partIndex) => ({
      ...part,
      id: `copied-${index}-${partIndex}` as never,
      sessionID: childId,
      messageID: `copied-${index}` as never,
      ...(part.type === "tool"
        ? {
            callID: "copied-call",
            state:
              part.state.status === "completed"
                ? {
                    ...part.state,
                    attachments: part.state.attachments?.map((attachment, attachmentIndex) => ({
                      ...attachment,
                      id: `attachment-${index}-${attachmentIndex}` as never,
                      sessionID: childId,
                      messageID: `copied-${index}` as never,
                    })),
                  }
                : part.state,
          }
        : {}),
    })),
  }));
  return {
    child: { ...parent, id: childId, parentID: parentId, taskType: "selection_side_chat" },
    messages: copied,
    entries: [],
    copySources: {
      messages: Object.fromEntries(
        messages.map((message, index) => [copied[index]!.info.id, message.info.id]),
      ),
      parts: Object.fromEntries(
        messages.flatMap((message, index) =>
          message.parts.map((part, partIndex) => [copied[index]!.parts[partIndex]!.id, part.id]),
        ),
      ),
    },
    commandFact: {
      parentSessionId: parentId,
      sourceCommandId: "source-command",
      ack: {
        commandId: "source-command",
        status: "accepted",
        revisionAtDecision: 1,
        result: { type: "createSelectionSideSession", sessionId: childId },
      },
      metadata: {},
    },
  };
}

async function fixture(
  fault?:
    | "afterChild"
    | "afterMessages"
    | "afterGoal"
    | "afterEntries"
    | "afterInput"
    | "afterCommandFact"
    | "beforeCommit",
) {
  const directory = await mkdtemp(join(tmpdir(), "fork-source-"));
  const dbPath = join(directory, "sessions.sqlite");
  const store = await createSqliteSessionStore({ dbPath, forkCommitFaultAt: fault });
  await store.createSession({
    id: parentId,
    projectID: "project" as never,
    slug: "parent",
    directory,
    title: "parent",
    version: "test",
  });
  await store.saveMessage({
    id: "original-message" as never,
    sessionID: parentId,
    role: "user",
    agent: "build",
    time: { created: 1 },
    tools: {},
    modelSelection: { providerId: "provider" as never, modelId: "model" as never },
  });
  await store.savePart({
    id: "original-text" as never,
    sessionID: parentId,
    messageID: "original-message" as never,
    type: "text",
    text: largeText,
  });
  await store.savePart({
    id: "original-tool" as never,
    sessionID: parentId,
    messageID: "original-message" as never,
    type: "tool",
    callID: "original-call",
    tool: "Read",
    state: {
      status: "completed",
      input: { payload: largeText, nullable: null },
      output: largeText,
      title: "Read",
      metadata: {},
      attachments: [
        {
          id: "original-attachment",
          sessionID: parentId,
          messageID: "original-message",
          type: "file",
          mime: "image/png",
          url: largeText,
        },
      ],
      time: { start: 1, end: 2 },
    },
  } as never);
  const raw = new DatabaseSync(dbPath);
  raw
    .prepare("update part set data=json_set(data,'$.future',json(?),'$.nullValue',null) where id=?")
    .run('{"payload":"keep","nested":[null,{"v":1}]}', "original-text");
  raw.close();
  return {
    store,
    dbPath,
    async close() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("SQLite fork from source", () => {
  it("locks the source through planning and leaves the child independent after commit", async () => {
    const f = await fixture();
    const writer = new DatabaseSync(f.dbPath);
    writer.exec("pragma busy_timeout=0");
    try {
      await f.store.commitForkFromSource({
        sessionID: parentId,
        build(source) {
          expect(() =>
            writer
              .prepare("update part set data=json_set(data,'$.text','changed') where id=?")
              .run("original-text"),
          ).toThrow(/locked/);
          return bundle(source.session, source.messages);
        },
      });
      writer
        .prepare("update part set data=json_set(data,'$.text','changed') where id=?")
        .run("original-text");
      expect((await f.store.messages({ sessionID: childId }))[0]!.parts[0]).toMatchObject({
        text: largeText,
      });
      writer.exec("pragma foreign_keys=on");
      writer.prepare("delete from session where id=?").run(childId);
      expect((await f.store.messages({ sessionID: parentId }))[0]!.parts[0]).toMatchObject({
        text: "changed",
      });
    } finally {
      writer.close();
      await f.close();
    }
  });

  it("keeps large payloads in SQLite and preserves raw fields while remapping metadata", async () => {
    const f = await fixture();
    try {
      const result = await f.store.commitForkFromSource({
        sessionID: parentId,
        build(source) {
          expect(JSON.stringify(source.messages)).not.toContain(largeText);
          return bundle(source.session, source.messages);
        },
      });
      expect(result.id).toBe(childId);
      const messages = await f.store.messages({ sessionID: childId });
      expect(messages[0]!.parts[0]).toMatchObject({
        text: largeText,
        future: { payload: "keep", nested: [null, { v: 1 }] },
        nullValue: null,
      });
      expect(messages[0]!.parts[1]).toMatchObject({
        callID: "copied-call",
        state: {
          input: { payload: largeText, nullable: null },
          output: largeText,
          attachments: [
            { id: "attachment-0-0", sessionID: childId, messageID: "copied-0", url: largeText },
          ],
        },
      });
      expect((await f.store.messages({ sessionID: parentId }))[0]!.parts[1]).toMatchObject({
        callID: "original-call",
      });
      const raw = new DatabaseSync(f.dbPath, { readOnly: true });
      expect(
        raw
          .prepare(
            "select json_extract(data,'$.model.modelID') model from message where session_id=?",
          )
          .get(childId)?.model,
      ).toBe("model");
      expect(raw.prepare("pragma quick_check").get()).toMatchObject({ quick_check: "ok" });
      raw.close();
    } finally {
      await f.close();
    }
  });

  it.each([
    "afterChild",
    "afterMessages",
    "afterGoal",
    "afterEntries",
    "afterInput",
    "afterCommandFact",
    "beforeCommit",
  ] as const)("rolls back all child rows and command facts after %s", async (fault) => {
    const f = await fixture(fault);
    try {
      await expect(
        f.store.commitForkFromSource({
          sessionID: parentId,
          build: (source) => bundle(source.session, source.messages),
        }),
      ).rejects.toThrow();
      expect(await f.store.getSession(childId)).toBeNull();
      expect(await f.store.messages({ sessionID: childId })).toEqual([]);
      expect(
        await f.store.sessionEntries({ sessionID: parentId, type: "v4/command_fact" }),
      ).toEqual([]);
      expect(await f.store.messages({ sessionID: parentId })).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("returns the same durable child for concurrent retries", async () => {
    const f = await fixture();
    try {
      const request: ForkFromSourceInput = {
        sessionID: parentId,
        build: (source) => bundle(source.session, source.messages),
      };
      const [first, second] = await Promise.all([
        f.store.commitForkFromSource(request),
        f.store.commitForkFromSource(request),
      ]);
      expect(second.id).toBe(first.id);
      expect(await f.store.messages({ sessionID: childId })).toHaveLength(1);
      expect(
        await f.store.sessionEntries({ sessionID: parentId, type: "v4/command_fact" }),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it.each(["message", "part", "collision"] as const)(
    "rejects an invalid %s copy without changing another session",
    async (kind) => {
      const f = await fixture();
      try {
        const siblingId = "sibling" as never;
        await f.store.createSession({
          id: siblingId,
          projectID: "project" as never,
          slug: "sibling",
          directory: "/workspace",
          title: "sibling",
          version: "test",
        });
        await f.store.saveMessage({
          id: "sibling-message" as never,
          sessionID: siblingId,
          role: "user",
          time: { created: 1 },
          agent: "build",
          tools: {},
        });
        await f.store.savePart({
          id: "sibling-part" as never,
          sessionID: siblingId,
          messageID: "sibling-message" as never,
          type: "text",
          text: "sibling body",
        });
        const before = await f.store.messages({ sessionID: siblingId });
        await expect(
          f.store.commitForkFromSource({
            sessionID: parentId,
            build(source) {
              const result = bundle(source.session, source.messages);
              if (kind === "message")
                result.copySources!.messages["copied-0"] = "sibling-message" as never;
              if (kind === "part")
                result.copySources!.parts["copied-0-0"] = "sibling-part" as never;
              if (kind === "collision") {
                result.messages[0]!.parts[0]!.id = "sibling-part" as never;
                result.copySources!.parts["sibling-part"] = "original-text" as never;
              }
              return result;
            },
          }),
        ).rejects.toThrow();
        expect(await f.store.getSession(childId)).toBeNull();
        expect(await f.store.messages({ sessionID: siblingId })).toEqual(before);
      } finally {
        await f.close();
      }
    },
  );

  it("rolls back a throwing or asynchronous planner and releases the transaction", async () => {
    const f = await fixture();
    try {
      await expect(
        f.store.commitForkFromSource({
          sessionID: parentId,
          build() {
            throw new Error("planner failed");
          },
        }),
      ).rejects.toThrow("planner failed");
      await expect(
        f.store.commitForkFromSource({
          sessionID: parentId,
          build: (async (source) =>
            bundle(source.session, source.messages)) as unknown as ForkFromSourceInput["build"],
        }),
      ).rejects.toThrow("must be synchronous");
      expect(await f.store.getSession(childId)).toBeNull();
      await expect(
        f.store.commitForkFromSource({
          sessionID: parentId,
          build: (source) => bundle(source.session, source.messages),
        }),
      ).resolves.toMatchObject({ id: childId });
    } finally {
      await f.close();
    }
  });

  it("preserves JSON scalar types when rewriting existing metadata", async () => {
    const f = await fixture();
    try {
      const message = (await f.store.messages({ sessionID: parentId }))[0]!;
      await f.store.saveMessage({
        ...message.info,
        metadata: {
          flag: false,
          nullable: "old",
          dropped: 1,
          ids: Array.from({ length: 1500 }, (_, index) => `source-${index}`),
        },
      });
      await f.store.commitForkFromSource({
        sessionID: parentId,
        build(source) {
          const result = bundle(source.session, source.messages);
          result.messages[0]!.info.metadata = {
            ...result.messages[0]!.info.metadata,
            flag: true,
            ids: Array.from({ length: 1500 }, (_, index) => `child-${index}`),
            nullable: null,
            dropped: undefined,
          };
          return result;
        },
      });
      expect((await f.store.messages({ sessionID: childId }))[0]!.info.metadata).toMatchObject({
        flag: true,
        ids: Array.from({ length: 1500 }, (_, index) => `child-${index}`),
        nullable: null,
      });
      expect((await f.store.messages({ sessionID: childId }))[0]!.info.metadata).not.toHaveProperty(
        "dropped",
      );
    } finally {
      await f.close();
    }
  });

  it("keeps legacy hidden reminder text available for model selection", async () => {
    const f = await fixture();
    try {
      const message = (await f.store.messages({ sessionID: parentId }))[0]!;
      await f.store.saveMessage({
        ...message.info,
        semantics: {
          origin: "migration",
          kind: "system_reminder",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
      });
      await f.store.commitForkFromSource({
        sessionID: parentId,
        build(source) {
          expect(source.messages[0]!.parts[0]).toMatchObject({ text: largeText });
          expect(source.messages[0]!.parts[1]).not.toHaveProperty("state.output");
          return bundle(source.session, source.messages);
        },
      });
    } finally {
      await f.close();
    }
  });

  it("preserves ordering across SQL batches including legacy null sequences", async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 270; index++) {
        const id = `ordered-${index}` as never;
        await f.store.saveMessage({
          id,
          sessionID: parentId,
          role: "user",
          time: { created: 270 - index },
          agent: "build",
          tools: {},
        });
        await f.store.savePart({
          id: `text-${index}` as never,
          sessionID: parentId,
          messageID: id,
          type: "text",
          text: String(index),
        });
      }
      const raw = new DatabaseSync(f.dbPath);
      raw.exec("update message set sequence=null where id in ('ordered-1', 'ordered-2')");
      raw.close();
      const before = await f.store.messages({ sessionID: parentId });
      const db = (f.store as unknown as { db: DatabaseSync }).db;
      const prepare = db.prepare.bind(db);
      const copyPlans: string[][] = [];
      db.prepare = (sql) => {
        const statement = prepare(sql);
        if (sql.includes("from json_each(?) plan")) {
          const run = statement.run.bind(statement);
          statement.run = (...args) => {
            const plan = prepare(`explain query plan ${sql}`).all(...args);
            copyPlans.push(plan.map((row) => String(row.detail)));
            return run(...args);
          };
        }
        return statement;
      };
      await f.store.commitForkFromSource({
        sessionID: parentId,
        build: (source) => bundle(source.session, source.messages),
      });
      expect(copyPlans.length).toBeGreaterThan(0);
      for (const plan of copyPlans) {
        expect(plan[0]).toMatch(/SCAN plan/);
        expect(plan[1]).toMatch(/SEARCH source USING INDEX .* \(id=\?\)/);
      }
      const after = await f.store.messages({ sessionID: childId });
      expect(
        after.map((message) => (message.parts[0]!.type === "text" ? message.parts[0]!.text : "")),
      ).toEqual(
        before.map((message) => (message.parts[0]!.type === "text" ? message.parts[0]!.text : "")),
      );
      expect(after.map((message) => message.info.metadata?.forkOrigin?.messageId)).toEqual(
        before.map((message) => message.info.id),
      );
    } finally {
      await f.close();
    }
  });
});
