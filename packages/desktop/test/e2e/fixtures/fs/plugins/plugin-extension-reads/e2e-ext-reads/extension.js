// E2E 扩展 fixture（docs/plugins/extension-host.md §17.3、§17.5，P3b）：纯 JS，不需要构建。
// - 订阅会话列表：日志记事件种类、rev、行数与种子会话数（标题以 E2E_READS_SEED_ 开头）。
// - 上限探测（每个隔离 HOME 只做一次）：列表里有 9 个种子会话时，对 9 个不同会话订阅行；
//   前 8 个应收到 reset，第 9 个应以 limit-exceeded 结束。然后全部退订。
// - 观察最近的非种子会话：订阅行与会话状态，镜像里第一次出现测试标记时调一次 readRows。视图 rows 显示镜像的行。
// - 长历史（标题以 E2E_READS_HISTORY 开头的会话优先观察）：行镜像只留尾部窗口；第一次 reset 后用
//   readRows({ beforeRowId }) 往前翻页直到 hasMore 为 false，记窗口行数、页数、总行数与是否翻到第一轮。
// 日志只记数量、种类、是否含测试标记，不记正文。运行时证据写进日志（E2E_READS_*）。
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SEED_PREFIX = "E2E_READS_SEED_";
const MARKER = "E2E_EXT_READS";
const REPLY = "deepseek-e2e-ok";
const PROBE_COUNT = 9;
const HISTORY_PREFIX = "E2E_READS_HISTORY";
const HISTORY_FIRST = "E2E_READS_HISTORY_ASK_001";
const HISTORY_PAGE_LIMIT = 20;

const textOf = (row) => (typeof row.text === "string" ? row.text : "");
const hasMarker = (rows) => rows.some((row) => textOf(row).includes(MARKER));
const hasReply = (rows) => rows.some((row) => textOf(row).includes(REPLY));
const kindsOf = (rows) => [...new Set(rows.map((row) => row.kind))].sort().join(",");
const hasHistoryFirst = (rows) => rows.some((row) => textOf(row).includes(HISTORY_FIRST));

export async function activate(ctx) {
  const root = join(ctx.extension.path, "..");
  await writeFile(
    join(root, "e2e-ext-reads-state.json"),
    JSON.stringify({ pid: process.pid, activatedAt: Date.now() }),
  );
  const probeFlag = join(root, "e2e-ext-reads-probed");
  const stateUri = `ui://${ctx.extension.id}/state`;
  const views = new Set();
  const sessions = new Map();
  let watched = null;
  let probing = false;
  const notify = () => {
    for (const view of views) view.notify(stateUri);
  };

  /** 从镜像窗口最早的一行往前翻页，直到 hasMore 为 false。 */
  const pageHistory = async (sessionId, windowRows) => {
    let before = Math.min(...windowRows.map((row) => row.rowId));
    let pages = 0;
    let total = windowRows.length;
    let hasMore = true;
    let hasFirst = hasHistoryFirst(windowRows);
    while (hasMore && pages < 50) {
      const result = await ctx.sessions.readRows({
        sessionId,
        beforeRowId: before,
        limit: HISTORY_PAGE_LIMIT,
      });
      pages += 1;
      total += result.rows.length;
      hasMore = result.hasMore;
      if (hasHistoryFirst(result.rows)) hasFirst = true;
      if (result.rows.length === 0) break;
      before = result.rows[0].rowId;
    }
    ctx.log.info(
      `E2E_READS_HISTORY session=${sessionId} window=${windowRows.length} windowHasFirst=${hasHistoryFirst(windowRows)} pages=${pages} total=${total} hasFirst=${hasFirst} hasMore=${hasMore}`,
    );
  };

  const watch = (sessionId, reason, title) => {
    if (watched?.sessionId === sessionId) return;
    watched?.dispose();
    const state = {
      sessionId,
      rows: new Map(),
      events: [],
      phase: null,
      readRows: null,
      paged: false,
    };
    const isHistory = title.startsWith(HISTORY_PREFIX);
    const rowsSub = ctx.sessions.onDidChangeRows(
      { sessionId },
      (event) => {
        if (event.kind === "reset") state.rows = new Map(event.rows.map((row) => [row.rowId, row]));
        if (event.kind === "reset" && isHistory && !state.paged && event.rows.length > 0) {
          state.paged = true;
          pageHistory(sessionId, event.rows).catch((error) =>
            ctx.log.info(
              `E2E_READS_HISTORY session=${sessionId} error=${error?.code ?? "unknown"}`,
            ),
          );
        } else if (event.kind === "rows") {
          for (const row of event.upserted) state.rows.set(row.rowId, row);
        }
        state.events.push(event.kind);
        const rows = [...state.rows.values()];
        ctx.log.info(
          `E2E_READS_ROWS session=${sessionId} kind=${event.kind} rows=${rows.length} kinds=${kindsOf(rows)} marker=${hasMarker(rows)} reply=${hasReply(rows)} events=${state.events.length}`,
        );
        // 新会话的第一个 reset 可能还是空的（草稿刚变成会话）：等镜像里出现测试标记再读一次。
        if (!state.readRows && hasMarker(rows)) {
          state.readRows = ctx.sessions.readRows({ sessionId, limit: 50 }).then(
            (result) =>
              ctx.log.info(
                `E2E_READS_READROWS session=${sessionId} rows=${result.rows.length} hasMore=${result.hasMore} marker=${hasMarker(result.rows)} epoch=${result.logEpoch ? "set" : "none"}`,
              ),
            (error) =>
              ctx.log.info(
                `E2E_READS_READROWS session=${sessionId} error=${error?.code ?? "unknown"}`,
              ),
          );
        }
        notify();
      },
      (error) => ctx.log.info(`E2E_READS_ROWS session=${sessionId} error=${error.code}`),
    );
    const conversationSub = ctx.sessions.onDidChangeConversation(
      { sessionId },
      (event) => {
        state.phase = event.phase;
        ctx.log.info(
          `E2E_READS_CONV session=${sessionId} phase=${event.phase} revision=${event.revision}`,
        );
        notify();
      },
      (error) => ctx.log.info(`E2E_READS_CONV session=${sessionId} error=${error.code}`),
    );
    state.dispose = () => {
      rowsSub.dispose();
      conversationSub.dispose();
    };
    watched = state;
    ctx.log.info(`E2E_READS_WATCH session=${sessionId} reason=${reason}`);
    notify();
  };

  /** 上限探测：9 个不同会话；前 8 个收到 reset，第 9 个以 limit-exceeded 结束。之后全部退订。 */
  const probeLimit = async (seeds) => {
    probing = true;
    const results = Array.from({ length: PROBE_COUNT }, () => null);
    const subscriptions = [];
    await new Promise((resolve) => {
      const settle = (index, result) => {
        if (results[index]) return;
        results[index] = result;
        if (results.every(Boolean)) resolve();
      };
      seeds.slice(0, PROBE_COUNT).forEach((seed, index) => {
        subscriptions.push(
          ctx.sessions.onDidChangeRows(
            { sessionId: seed.session.sessionId },
            (event) => settle(index, `event:${event.kind}`),
            (error) => settle(index, `error:${error.code}`),
          ),
        );
      });
    });
    ctx.log.info(`E2E_READS_LIMIT results=${results.join(",")}`);
    for (const subscription of subscriptions) subscription.dispose();
    await writeFile(probeFlag, "1");
    ctx.log.info("E2E_READS_LIMIT released");
    probing = false;
  };

  const onList = async (event) => {
    if (event.kind === "snapshot") {
      sessions.clear();
      for (const row of event.sessions) sessions.set(row.session.sessionId, row);
    } else {
      for (const row of event.upserted) sessions.set(row.session.sessionId, row);
      for (const ref of event.removed) sessions.delete(ref.sessionId);
    }
    const all = [...sessions.values()];
    const seeds = all
      .filter((row) => row.title.startsWith(SEED_PREFIX))
      .sort((a, b) => (a.session.sessionId < b.session.sessionId ? -1 : 1));
    ctx.log.info(
      `E2E_READS_LIST kind=${event.kind} rev=${event.rev} count=${all.length} seeds=${seeds.length} truncated=${event.kind === "snapshot" ? Boolean(event.truncated) : "n/a"}`,
    );
    if (probing) return;
    const probed = await access(probeFlag).then(
      () => true,
      () => false,
    );
    if (!probed && seeds.length >= PROBE_COUNT) {
      await probeLimit(seeds);
    }
    const live = all
      .filter((row) => !row.title.startsWith(SEED_PREFIX) && !row.archived)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const target = live.find((row) => row.title.startsWith(HISTORY_PREFIX)) ?? live[0];
    if (target) watch(target.session.sessionId, event.kind, target.title);
  };

  ctx.sessions.onDidChangeList(
    (event) => void onList(event),
    (error) => ctx.log.info(`E2E_READS_LIST error=${error.code}`),
  );

  ctx.views.register("rows", {
    entry: "./view.html",
    onDidOpen: (view) => {
      views.add(view);
      view.onDidClose(() => views.delete(view));
    },
    tools: {
      state: {
        description: "Read the mirrored rows of the watched session",
        inputSchema: { type: "object", properties: {} },
        run: async () => {
          const rows = watched ? [...watched.rows.values()] : [];
          return {
            sessionId: watched?.sessionId ?? null,
            phase: watched?.phase ?? null,
            events: watched?.events ?? [],
            rows: rows.map((row) => ({
              rowId: row.rowId,
              kind: row.kind,
              text: textOf(row).slice(0, 200),
            })),
          };
        },
      },
    },
    resources: {
      [stateUri]: {
        mimeType: "application/json",
        read: async () => JSON.stringify({ rows: watched?.rows.size ?? 0 }),
      },
    },
  });
}

export function deactivate() {}
