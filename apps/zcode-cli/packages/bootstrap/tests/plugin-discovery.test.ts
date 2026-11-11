import { describe, expect, it, vi } from "vitest";
import { searchPluginCatalog } from "../src/plugin-discovery/search.js";
import { createPluginDiscoveryPort } from "../src/plugin-discovery/port.js";
import type { PluginDiscoveryContext, PluginDiscoveryCandidate } from "@zcode/contracts";

const pluginId = "mail@zcode-plugins-official";
const candidate: PluginDiscoveryCandidate = {
  pluginId,
  name: "mail",
  description: "Search email messages",
  installed: false,
  enabled: false,
  action: "install",
  scope: "user",
  displayNameI18n: { zh: "邮件助手" },
  examplePrompts: ["整理收件箱"],
};
const context = (signal = new AbortController().signal): PluginDiscoveryContext => ({
  sessionId: "session",
  toolCallId: "tool",
  traceId: "trace",
  turnId: "turn",
  signal,
});

describe("official plugin discovery", () => {
  it("searches multilingual listing and prompts, excludes personal and retired plugins", () => {
    const catalog = [
      candidate,
      { ...candidate, pluginId: "mail@personal" },
      { ...candidate, pluginId: "restore-legacy-sessions@zcode-plugins-official" },
    ];
    for (const query of ["邮件", "EMAIL", "收件箱"]) {
      expect(searchPluginCatalog(catalog, { query }, false).plugins.map((p) => p.pluginId)).toEqual(
        [pluginId],
      );
    }
    expect(searchPluginCatalog(catalog, { query: "weather" }, false).plugins).toEqual([]);
  });
  it("paginates deterministically and rejects a cursor from a different query or catalog", () => {
    const catalog = Array.from({ length: 14 }, (_, i) => ({
      ...candidate,
      pluginId: `mail-${i}@zcode-plugins-official`,
    }));
    const first = searchPluginCatalog(catalog, { query: "email" }, true);
    expect(first.plugins).toHaveLength(10);
    expect(first.stale).toBe(true);
    const second = searchPluginCatalog(catalog, { query: "email", cursor: first.cursor }, true);
    expect(new Set([...first.plugins, ...second.plugins].map((p) => p.pluginId)).size).toBe(14);
    expect(() =>
      searchPluginCatalog(catalog, { query: "邮件", cursor: first.cursor }, false),
    ).toThrow();
    expect(() =>
      searchPluginCatalog(catalog.slice(1), { query: "email", cursor: first.cursor }, false),
    ).toThrow();
  });
  const entry = (name: string, fields: Partial<PluginDiscoveryCandidate> = {}) => ({
    ...candidate,
    name,
    pluginId: name + "@zcode-plugins-official",
    displayNameI18n: {},
    examplePrompts: [],
    description: "",
    ...fields,
  });
  const names = (catalog: PluginDiscoveryCandidate[], query: string) =>
    searchPluginCatalog(catalog, { query }, false).plugins.map((p) => p.name);
  it("ranks exact canonical ID/name, then localized display name, ahead of ordinary matches", () => {
    const entries = [
      entry("a", { displayName: "pdf helper" }),
      entry("b", { displayNameI18n: { zh: "ＰＤＦ" } }),
      entry("pdf"),
      entry("c", { description: "pdf pdf pdf" }),
    ];
    expect(names(entries, "ＰＤＦ").slice(0, 2)).toEqual(["pdf", "b"]);
    expect(names(entries, "PDF@zcode-plugins-official")[0]).toBe("pdf");
    expect(names(entries, "official")).toEqual([]);
  });
  it("uses Han bigrams without joining across punctuation or field boundaries; Latin terms are whole words", () => {
    const entries = [
      entry("a", { description: "整理收件箱文档" }),
      entry("b", { description: "整理收，件箱" }),
      entry("c", { description: "收", examplePrompts: ["件"] }),
      entry("d", { description: "mailbox", displayName: "箱" }),
    ];
    expect(names(entries, "请整理收件")).toContain("a");
    expect(names(entries, "收件")).toEqual(["a"]);
    expect(names(entries, "箱")).toEqual(["d"]);
    expect(names(entries, "mail")).toEqual([]);
  });
  it("scores rare terms, real repetition and concise details; duplicated translations or queries add no votes", () => {
    const entries = [
      entry("a", {
        description: "report",
        descriptionI18n: { en: "REPORT" },
        examplePrompts: ["report"],
      }),
      entry("b", { description: "report report" }),
      entry("c", { description: "report " + "padding ".repeat(25) }),
      entry("d", { description: "ledger" }),
      entry("e", { description: "report" }),
    ];
    expect(names(entries, "report ledger")).toEqual(["d", "b", "a", "e", "c"]);
    expect(names(entries, "report report ledger")).toEqual(names(entries, "report ledger"));
    expect(names(entries.toReversed(), "report ledger")).toEqual(names(entries, "report ledger"));
  });
  it("binds versioned cursors to the complete visible snapshot independent of catalog order", () => {
    const catalog = Array.from({ length: 12 }, (_, i) => entry("p" + i, { description: "mail" }));
    const extra = entry("z", { description: "calendar" });
    const first = searchPluginCatalog([...catalog, extra], { query: "mail" }, false);
    expect(first.cursor).toMatch(/^bm25-v1:/);
    const run = (entries: PluginDiscoveryCandidate[], query: string, cursor = first.cursor) =>
      searchPluginCatalog(entries, { query, cursor }, false);
    expect(run([extra, ...catalog.toReversed()], "ＭＡＩＬ").plugins).toHaveLength(2);
    expect(() => run(catalog, "mail")).toThrow(/cursor/);
    expect(() => run([...catalog, extra], "mail mail")).toThrow(/cursor/);
    expect(() => run([...catalog, extra], "mail", first.cursor!.replace(/:10$/, ":12"))).toThrow(
      /cursor/,
    );
    expect(() => run([...catalog, extra], "mail", first.cursor!.replace(/^bm25-v1:/, ""))).toThrow(
      /cursor/,
    );
  });
});

function setup(accepted = true) {
  const resolve = vi.fn(async () => candidate);
  const refresh = vi.fn(async () => ({ stale: false }));
  const apply = vi.fn(async () => true);
  const confirm = vi.fn(async () => accepted);
  const deps = { list: () => [candidate], resolve, refresh, apply, confirm };
  return { ...deps, port: createPluginDiscoveryPort(deps) };
}

describe("plugin install confirmation", () => {
  it("clears a previous skip after an explicitly reconsidered installation succeeds", async () => {
    const deps = setup(false);
    await deps.port.suggest({ pluginId, reason: "mail" }, context());
    deps.confirm.mockResolvedValue(true);
    await deps.port.suggest(
      { pluginId, reason: "User asks again", reconsider: true },
      { ...context(), turnId: "new-turn", toolCallId: "install-again" },
    );
    deps.resolve.mockResolvedValue({
      ...candidate,
      installed: true,
      enabled: true,
      action: "none",
    });
    expect(
      await deps.port.suggest(
        { pluginId, reason: "mail" },
        { ...context(), turnId: "later-turn", toolCallId: "already-installed" },
      ),
    ).toMatchObject({ status: "alreadyAvailable" });
    expect(deps.confirm).toHaveBeenCalledTimes(2);
  });
  it("rechecks scope after confirmation and does not mutate a newly changed workspace override", async () => {
    const deps = setup();
    deps.resolve.mockResolvedValueOnce(candidate).mockResolvedValueOnce({
      ...candidate,
      installed: true,
      enabled: false,
      action: "enable",
      scope: "workspace",
    });
    expect(await deps.port.suggest({ pluginId, reason: "mail" }, context())).toMatchObject({
      status: "unavailable",
    });
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("restores skipped history and only reconsiders on an explicit request in a later turn", async () => {
    const deps = setup();
    const port = createPluginDiscoveryPort({
      ...deps,
      readSkipped: async () => new Map([[pluginId, "old-turn"]]),
    });
    expect(await port.suggest({ pluginId, reason: "mail" }, context())).toMatchObject({
      status: "skipped",
    });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(
      await port.suggest(
        { pluginId, reason: "User asked again", reconsider: true },
        { ...context(), toolCallId: "later", turnId: "new-turn" },
      ),
    ).toMatchObject({ status: "installed" });
  });
  it("does not ask to reinstall an installed enabled plugin", async () => {
    const deps = setup();
    deps.resolve.mockResolvedValue({
      ...candidate,
      installed: true,
      enabled: true,
      action: "none",
    });
    expect(await deps.port.suggest({ pluginId, reason: "mail" }, context())).toMatchObject({
      status: "alreadyAvailable",
    });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("reports installation failure and allows a new confirmed retry", async () => {
    const deps = setup();
    deps.apply.mockRejectedValueOnce(new Error("download failed"));
    expect(await deps.port.suggest({ pluginId, reason: "mail" }, context())).toMatchObject({
      status: "failed",
    });
    expect(
      await deps.port.suggest(
        { pluginId, reason: "Retry requested" },
        { ...context(), toolCallId: "retry" },
      ),
    ).toMatchObject({ status: "installed" });
    expect(deps.confirm).toHaveBeenCalledTimes(2);
  });
  it("waits for explicit confirmation and returns refreshRequired without an activation adapter", async () => {
    const deps = setup();
    let approve!: (value: boolean) => void;
    deps.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const request = deps.port.suggest({ pluginId, reason: "读取用户需要的邮件" }, context());
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalledOnce());
    expect(deps.apply).not.toHaveBeenCalled();
    approve(true);
    expect(await request).toMatchObject({ status: "installed", activation: "refreshRequired" });
    expect(deps.refresh).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(deps.apply).toHaveBeenCalledOnce();
  });
  it("skip suppresses repeat recommendations and never mutates plugins", async () => {
    const deps = setup(false);
    expect(await deps.port.suggest({ pluginId, reason: "邮件" }, context())).toMatchObject({
      status: "skipped",
    });
    expect(await deps.port.suggest({ pluginId, reason: "邮件" }, context())).toMatchObject({
      status: "skipped",
    });
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("rejects arbitrary or retired sources before confirmation", async () => {
    const deps = setup();
    for (const id of [
      "mail@personal",
      "https://example.com/plugin.zip",
      "restore-legacy-sessions@zcode-plugins-official",
    ]) {
      expect(await deps.port.suggest({ pluginId: id, reason: "mail" }, context())).toMatchObject({
        status: "unavailable",
      });
    }
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("fails closed when refresh fails after confirmation", async () => {
    const deps = setup();
    deps.refresh.mockResolvedValue({ stale: true });
    expect(await deps.port.suggest({ pluginId, reason: "mail" }, context())).toMatchObject({
      status: "unavailable",
    });
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("cancellation after confirmation cannot begin installation", async () => {
    const deps = setup();
    const controller = new AbortController();
    deps.confirm.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    await expect(
      deps.port.suggest({ pluginId, reason: "mail" }, context(controller.signal)),
    ).rejects.toThrow();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("does not reload if another installer won the race under the write lock", async () => {
    const deps = setup();
    deps.apply.mockResolvedValue(false);
    const activate = vi.fn(async (_pluginId, _context, changed: boolean) => {
      expect(changed).toBe(false);
      return "refreshRequired" as const;
    });
    const port = createPluginDiscoveryPort({ ...deps, activate });
    expect(await port.suggest({ pluginId, reason: "mail" }, context())).toMatchObject({
      status: "alreadyAvailable",
    });
  });
  it.each(["ready", "needsConfiguration", "refreshRequired", "failed"] as const)(
    "preserves installation success with activation %s",
    async (activation) => {
      const deps = setup();
      const port = createPluginDiscoveryPort({ ...deps, activate: async () => activation });
      expect(await port.suggest({ pluginId, reason: "mail" }, context())).toMatchObject({
        status: "installed",
        activation,
      });
    },
  );
});
