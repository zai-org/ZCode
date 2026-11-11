// DCA-V1-06：共享审批在旧 build 模式下的 Hook 改写交互，不修改 Guarded 产品合同。
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  clearAppData,
  getE2EAppDataPaths,
  restoreCliConfig,
  seedCliConfig,
  snapshotCliConfig,
  type CliConfigSnapshot,
} from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
  startElectronWindowRecording,
} from "#e2e/helpers/electron-window-recorder";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE = "conversation-session-permission-hook-rewrite";
const MARKER = "E2E_PERMISSION_HOOK_REWRITE";
const TOOL_ID = "toolu_e2e_permission_hook_rewrite";
const ROOT = resolveE2ERuntimePath(CASE);
const ARTIFACT = join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), CASE);
const DIALOG =
  '[role="listbox"][aria-label="Permission required"], [role="listbox"][aria-label="需要权限"]';
const ALLOW = '[role="listbox"] [data-permission-option-kind="allowOnce"]';
const DOCK = '[data-v4-composer-dock="true"]';
const RULES = JSON.stringify({ version: 1, ask: [{ toolName: "Write" }] });
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

interface BrowserObservation {
  commands: Array<{ id: string; at: number; held: boolean }>;
  frames: Array<{ at: number; count: number; text: string }>;
  release: () => void;
  restore: () => void;
}
declare global {
  interface Window {
    __permissionRewriteReview?: BrowserObservation;
  }
}

describe("PermissionRequest Hook 改写后的确认替换", () => {
  let config: CliConfigSnapshot;
  before(async function () {
    this.timeout(120000);
    await mkdir(ROOT, { recursive: true });
    await mkdir(ARTIFACT, { recursive: true });
    const source = fileURLToPath(
      new URL(
        "../../fixtures/fs/conversation-session/conversation-session-permission-hook-rewrite/hook.mjs",
        import.meta.url,
      ),
    );
    const script = join(ROOT, "hook.mjs");
    await copyFile(source, script);
    config = await snapshotCliConfig();
    const commandHook = {
      type: "process",
      command: process.execPath,
      args: [script, ROOT],
      timeoutMs: 90000,
    };
    await seedCliConfig({
      hooks: {
        enabled: true,
        timeoutMs: 90000,
        events: {
          PermissionRequest: [{ matcher: "Write", hooks: [commandHook] }],
          PostToolUse: [{ matcher: "Write", hooks: [commandHook] }],
        },
      },
    });
    // 新隔离 profile 先完成 staging 的职业引导，再进入原审批测试。
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E();
    await switchV4Mode("build");
    // 先通过真实提交建立 session/project；只在隔离 E2E 数据库布置项目 ask 前置条件。
    await sendV4Prompt(`${MARKER}_SETUP Prepare the approval interaction demonstration.`);
    await waitForV4TimelineContaining(`${MARKER}_READY`, 60000);
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    withDatabase((db) => {
      const session = db.prepare("select project_id from session where id = ?").get(sessionId!) as {
        project_id: string;
      };
      expect(session.project_id).toBeTruthy();
      db.prepare(
        "insert into local_setting (scope, scope_id, namespace, key, value, schema_version, time_created, time_updated) values ('project', ?, 'permission', 'ruleset', ?, 1, ?, ?)",
      ).run(session.project_id, RULES, Date.now(), Date.now());
    });
  });
  after(async () => {
    await browser.execute(() => window.__permissionRewriteReview?.restore());
    if (config) await restoreCliConfig(config);
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(ROOT, { recursive: true, force: true });
  });

  it("DCA-V1-06: 旧确认被 B 替换，迟到 A 批准无效，B 仅执行一次", async function () {
    this.timeout(180000);
    await observeAndDelayFirstApproval();
    // 转正后强制录屏会让无 ffmpeg 的默认回放在业务通过后失败；仅人工审核需要视频。
    const recording =
      process.env.ZCODE_E2E_MANUAL_REVIEW === "1"
        ? await startElectronWindowRecording({
            outputPath: join(ARTIFACT, "approval-replacement.webm"),
            frameIntervalMs: 100,
          })
        : null;
    let staleResponse: Record<string, unknown> | undefined;
    try {
      await sendV4Prompt(
        `${MARKER}_RUN Write A-after-model.txt with the original content exactly once.`,
      );
      await waitForV4PermissionDialogInComposerDock();
      await browser.waitUntil(async () =>
        (await readTrace()).some((item) => item.phase === "started"),
      );
      expect(await $(DOCK).getText()).toContain("A-after-model.txt");
      await browser.saveScreenshot(join(ARTIFACT, "01-original-A.png"));
      expect(await exists(join(ROOT, "A-after-model.txt"))).toBe(false);
      // 人工审核需要读清 A；仅延长录屏展示，不代替上面的条件等待和断言。
      if (recording) await browser.pause(3000);
      // 真实 WebDriver 点击；只延迟它生成的原始 RPC 包，不伪造批准或权限事件。
      await $(ALLOW).click();
      await browser.waitUntil(async () => (await observation()).commands.length === 1, {
        timeout: 10000,
        timeoutMsg: "没有捕获到真实 UI 生成的旧批准命令",
      });
      await writeFile(join(ROOT, "release"), "release Hook rewrite");
      await browser.waitUntil(async () => (await $(DOCK).getText()).includes("B-after-hook.txt"), {
        timeout: 30000,
        timeoutMsg: "Hook 返回后未显示修改后的 B 确认",
      });
      await waitForV4PermissionDialogInComposerDock();
      await browser.saveScreenshot(join(ARTIFACT, "02-rewritten-B.png"));
      await browser.execute(() => window.__permissionRewriteReview!.release());
      // interaction 命令不进入通用 UI ACK buffer；用 CLI 的精确 ID 终态证明服务端已处理旧包。
      const oldId = (await observation()).commands[0]!.id;
      await browser.waitUntil(
        async () => {
          staleResponse = await readStaleResponse(oldId);
          return Boolean(staleResponse);
        },
        { timeout: 15000, timeoutMsg: "CLI 未确认旧 interactionId 已失效" },
      );
      expect(await $(DOCK).getText()).toContain("B-after-hook.txt");
      expect(await exists(join(ROOT, "B-after-hook.txt"))).toBe(false);
      expect((await readTrace()).filter((item) => item.phase === "executed")).toHaveLength(0);
      await browser.saveScreenshot(join(ARTIFACT, "03-stale-A-still-pending-B.png"));
      // 原版 B 只展示约半秒；保留阅读时间，旧响应失效和未执行已在上面验证。
      if (recording) await browser.pause(3000);
      await $(ALLOW).click();
      await waitForV4TimelineContaining(`${MARKER}_DONE`, 60000);
      await browser.waitUntil(async () =>
        (await readTrace()).some((item) => item.phase === "executed"),
      );
      expect(await exists(join(ROOT, "A-after-model.txt"))).toBe(false);
      expect(await readFile(join(ROOT, "B-after-hook.txt"), "utf8")).toBe(
        "Approved rewritten input B\n",
      );
      const trace = await readTrace();
      expect(trace.filter((item) => item.phase === "started")).toHaveLength(1);
      expect(trace.filter((item) => item.phase === "executed")).toHaveLength(1);
      const result = await getLatestUpstreamToolResultByToolCallId(TOOL_ID);
      expect(result?.isError).toBe(false);
      expect(result?.content).toContain("B-after-hook.txt");
      const captured = await observation();
      expect(captured.commands).toHaveLength(2);
      expect(captured.commands[0]!.id).not.toBe(captured.commands[1]!.id);
      expect(Math.max(...captured.frames.map((frame) => frame.count))).toBe(1);
      expect(await $$(DIALOG).length).toBe(0);
      expect(
        withDatabase((db) =>
          db
            .prepare(
              "select value from local_setting where namespace = 'permission' and key = 'ruleset'",
            )
            .all(),
        ),
      ).toEqual([{ value: RULES }]);
      await browser.saveScreenshot(join(ARTIFACT, "04-completed-B.png"));
    } finally {
      await writeFile(
        join(ARTIFACT, "interaction-evidence.json"),
        JSON.stringify(
          {
            clientMode: "desktop-continuous",
            video_capture_mode: recording ? ELECTRON_WINDOW_RECORDING_CAPTURE_MODE : null,
            ...(await observation()),
            staleResponse,
            trace: await readTrace(),
          },
          null,
          2,
        ),
      );
      await recording?.stop({ tailDurationMs: 500 });
    }
  });
});

function withDatabase<T>(action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"));
  try {
    return action(db);
  } finally {
    db.close();
  }
}

async function readTrace(): Promise<Array<{ phase: string }>> {
  if (!(await exists(join(ROOT, "trace.jsonl")))) return [];
  return (await readFile(join(ROOT, "trace.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readStaleResponse(id: string): Promise<Record<string, unknown> | undefined> {
  const logDir =
    process.env.ZCODE_LOG_DIR?.trim() || join(getE2EAppDataPaths().storageRoot, "cli", "log");
  for (const name of await readdir(logDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const lines = (await readFile(join(logDir, name), "utf8")).split("\n");
    for (const line of lines.slice(0, -1)) {
      if (
        line.includes('"event":"zcode_protocol.v4.interaction_already_resolved"') &&
        line.includes(id)
      )
        return JSON.parse(line) as Record<string, unknown>;
    }
  }
  return undefined;
}

function observation() {
  return browser.execute(() => ({
    commands: window.__permissionRewriteReview?.commands ?? [],
    frames: window.__permissionRewriteReview?.frames ?? [],
  }));
}

async function observeAndDelayFirstApproval() {
  await browser.execute((selector) => {
    const original = MessagePort.prototype.postMessage;
    const commands: BrowserObservation["commands"] = [];
    const frames: BrowserObservation["frames"] = [];
    let held: { port: MessagePort; data: Uint8Array } | undefined;
    const capture = () => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const frame = {
        at: performance.now(),
        count: dialogs.length,
        text: dialogs
          .map(
            (item) =>
              item.closest<HTMLElement>('[data-v4-composer-dock="true"]')?.innerText ??
              item.innerText,
          )
          .join("\n"),
      };
      const previous = frames.at(-1);
      if (!previous || previous.count !== frame.count || previous.text !== frame.text)
        frames.push(frame);
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    capture();
    // MessagePortProtocol 发送 Uint8Array；JSON 载荷嵌在 RPC binary 中。
    // 仅识别并暂存第一条真实 resolveInteraction allowOnce 包，其余消息原样转发。
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (
          text.includes('"type":"resolveInteraction"') &&
          text.includes('"optionId":"allowOnce"')
        ) {
          const id = /"interactionId":"([^"]+)"/.exec(text)?.[1];
          if (!id) throw new Error("批准命令缺失 interactionId");
          commands.push({ id, at: performance.now(), held: commands.length === 0 });
          if (commands.length === 1) {
            held = { port: this, data: message.slice() };
            return;
          }
        }
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__permissionRewriteReview = {
      commands,
      frames,
      release() {
        if (!held) throw new Error("没有待投递的旧批准");
        original.call(held.port, held.data);
        held = undefined;
      },
      restore() {
        MessagePort.prototype.postMessage = original;
        observer.disconnect();
        if (held) original.call(held.port, held.data);
        delete window.__permissionRewriteReview;
      },
    };
  }, DIALOG);
}
