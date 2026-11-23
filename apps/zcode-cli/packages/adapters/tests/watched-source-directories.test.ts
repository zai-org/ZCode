import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createWatchedEntry,
  WATCHED_SOURCE_DEBOUNCE_MS,
  type WatchedLoad,
} from "../src/watch/watched-source.js";

type Ignored = (path: string, stats?: Awaited<ReturnType<typeof stat>>) => boolean;

const state = vi.hoisted(() => ({
  watchers: [] as Array<EventEmitter & { anchor: string; ignored: Ignored; closed: boolean }>,
}));
vi.mock("chokidar", () => ({
  watch: (anchor: string, options: { ignored: Ignored }) => {
    const watcher = Object.assign(new EventEmitter(), {
      anchor,
      ignored: options.ignored,
      closed: false,
      close: vi.fn(async () => {
        watcher.closed = true;
      }),
    });
    state.watchers.push(watcher);
    queueMicrotask(() => watcher.emit("ready"));
    return watcher;
  },
}));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "watched-source-directories-"));
  state.watchers = [];
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function open() {
  return state.watchers.filter((watcher) => !watcher.closed);
}

/** 每次 load 按当前磁盘重新给出监听集合，与真实加载器一致。 */
function loaderOf(
  compute: () => Promise<Omit<WatchedLoad, "commit">> | Omit<WatchedLoad, "commit">,
) {
  const load = vi.fn(async () => ({ ...(await compute()), commit: () => {} }));
  return load;
}

it("watches an existing directory itself and admits only its direct child directories", async () => {
  const skills = join(root, "skills");
  await mkdir(join(skills, "existing"), { recursive: true });
  await writeFile(join(skills, "existing", "SKILL.md"), "---\nname: existing\n---\n");
  await writeFile(join(skills, "README.md"), "notes");
  const load = loaderOf(() => ({
    files: new Set([join(skills, "SKILL.md")]),
    directories: new Set([skills]),
  }));
  const entry = await createWatchedEntry({
    load,
    bounds: [root],
    childName: (name) => !name.startsWith("."),
    label: "Skill catalog",
  });
  try {
    expect(open().map((watcher) => watcher.anchor)).toEqual([skills]);
    const { ignored } = open()[0]!;
    const directory = await stat(join(skills, "existing"));
    const file = await stat(join(skills, "README.md"));
    expect(ignored(skills)).toBe(false);
    // 子目录在 depth 0 下不开句柄；新建、删除、改名都落在根目录的事件里。
    expect(ignored(join(skills, "existing"))).toBe(false);
    expect(ignored(join(skills, "existing"), directory)).toBe(false);
    expect(ignored(join(skills, "fresh"))).toBe(false);
    // 修复前 relevant 只认登记的文件及其祖先，新建的 skill 目录事件被丢掉。
    // 带文件类型时直接子文件不登记就不相关：chokidar 会给每个通过过滤的文件单独开句柄。
    expect(ignored(join(skills, "README.md"), file)).toBe(true);
    expect(ignored(join(skills, "SKILL.md"), file)).toBe(false);
    expect(ignored(join(skills, ".hidden"), directory)).toBe(true);
    expect(ignored(join(skills, "existing", "SKILL.md"), file)).toBe(true);
    expect(ignored(join(root, "elsewhere"), directory)).toBe(true);
  } finally {
    entry.close();
  }
});

it("reloads for a direct child directory event and ignores nested and filtered paths", async () => {
  const skills = join(root, "skills");
  await mkdir(skills, { recursive: true });
  const load = loaderOf(() => ({ files: new Set<string>(), directories: new Set([skills]) }));
  const entry = await createWatchedEntry({
    load,
    bounds: [root],
    childName: (name) => !name.startsWith("."),
    label: "Skill catalog",
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const watcher = open()[0]!;
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(WATCHED_SOURCE_DEBOUNCE_MS);
      await vi.advanceTimersByTimeAsync(0);
      await entry.flush();
    };
    const before = load.mock.calls.length;
    watcher.emit("raw", "rename", "nested", { watchedPath: join(skills, "child") });
    watcher.emit("raw", "rename", ".DS_Store", { watchedPath: skills });
    await vi.advanceTimersByTimeAsync(WATCHED_SOURCE_DEBOUNCE_MS * 2);
    expect(load.mock.calls.length).toBe(before);

    watcher.emit("raw", "rename", "fresh", { watchedPath: skills });
    await settle();
    expect(load.mock.calls.length).toBeGreaterThan(before);
  } finally {
    entry.close();
  }
});

it("anchors a missing directory inside its bound and moves to the directory once created", async () => {
  const base = join(root, "home", ".agents");
  const skills = join(base, "skills");
  const outside = join(root, "home", ".zcode", "skills");
  await mkdir(base, { recursive: true });
  const load = loaderOf(() => ({
    files: new Set<string>(),
    directories: new Set([skills, outside]),
  }));
  const entry = await createWatchedEntry({
    load,
    bounds: [base, join(root, "home", ".zcode")],
    childName: () => true,
    label: "Skill catalog",
  });
  try {
    // 边界目录本身不存在时不监听，不向上监听用户目录。
    expect(open().map((watcher) => watcher.anchor)).toEqual([base]);
    expect(open()[0]!.ignored(skills)).toBe(false);
    expect(open()[0]!.ignored(join(base, "other"))).toBe(true);

    await mkdir(skills);
    await entry.flush();
    expect(open().map((watcher) => watcher.anchor)).toEqual([skills]);
  } finally {
    entry.close();
  }
});

it("anchors a registered missing file on its existing directory and releases it once dropped", async () => {
  const skills = join(root, "skills");
  const pending = join(skills, "pending");
  await mkdir(pending, { recursive: true });
  const load = loaderOf(async () => {
    const candidate = join(pending, "SKILL.md");
    const exists = await stat(candidate).then(
      () => true,
      () => false,
    );
    return {
      files: new Set(exists ? [] : [candidate]),
      directories: new Set([skills]),
    };
  });
  const entry = await createWatchedEntry({
    load,
    bounds: [root],
    childName: () => true,
    label: "Skill catalog",
  });
  try {
    expect(
      open()
        .map((watcher) => watcher.anchor)
        .toSorted(),
    ).toEqual([pending, skills].toSorted());
    const temporary = open().find((watcher) => watcher.anchor === pending)!;
    expect(temporary.ignored(join(pending, "SKILL.md"))).toBe(false);
    expect(temporary.ignored(join(pending, "notes.md"))).toBe(true);

    await writeFile(join(pending, "SKILL.md"), "---\nname: pending\n---\n");
    await entry.flush();
    expect(open().map((watcher) => basename(watcher.anchor))).toEqual(["skills"]);
  } finally {
    entry.close();
  }
});
