import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_COMPOSER_VOICE_INPUT,
  TID_V4_COMPOSER_VOICE_WAVEFORM,
} from "@zcode/shared/test-ids";
import { readSettings, seedSettings, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import {
  startAsrFrameDroppingProxy,
  type AsrMockScenario,
  type AsrMockSession,
} from "#e2e/helpers/asr-mock-server";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  clickV4Send,
  getV4Messages,
  getV4PaneSnapshot,
  pasteV4ComposerFileAttachment,
  waitForV4RowAttachments,
  selectV4TaskById,
  setV4ComposerText,
  startNewV4Draft,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { getToastMessages, waitForToastContaining } from "#e2e/helpers/conversation-session-toast";

// 规格：docs/chat/composer-voice-input.md。麦克风由 wdio appArgs 的 Chromium 假设备提供（持续正弦音）。

type LexicalInputE2EElement = HTMLElement & {
  __zcodeLexicalInputE2E?: {
    getText: () => string;
    focus: () => void;
    setText: (text: string) => void;
  };
};

const PREFIX = "前缀";

const byId = (id: string) => $(`[data-testid="${id}"]`);

// 替身由 wdio beforeSession 在 Electron 启动前启动（prepareVoiceInputFixture）。
function mockOrigin(): string {
  const value = process.env.ZCODE_E2E_ASR_MOCK_URL;
  if (!value) throw new Error("缺少语音输入 ASR 替身");
  return value;
}

async function resetMock(scenario: AsrMockScenario) {
  await fetch(`${mockOrigin()}/__e2e/asr/reset`, {
    method: "POST",
    body: JSON.stringify(scenario),
  });
}

async function mockState(): Promise<{
  ticketRequests: Array<{ authorization?: string; body: string }>;
  sessions: AsrMockSession[];
}> {
  return (await (await fetch(`${mockOrigin()}/__e2e/asr/state`)).json()) as never;
}

async function voiceState(): Promise<string | null> {
  const button = await byId(TID_V4_COMPOSER_VOICE_INPUT);
  return (await button.isExisting()) ? button.getAttribute("data-voice-state") : null;
}

async function waitForVoiceState(state: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await voiceState()) === state, {
    timeout: 15_000,
    timeoutMsg: `${timeoutMsg}; latest=${await voiceState()}`,
  });
}

async function editorText(): Promise<string> {
  return browser.execute((id) => {
    const root = document.querySelector<LexicalInputE2EElement>(`[data-testid="${id}"]`);
    return root?.__zcodeLexicalInputE2E?.getText() ?? "";
  }, TID_V4_COMPOSER_INPUT);
}

/** 每个用例从固定草稿开始，光标在末尾，输入框保持焦点。 */
async function resetEditor() {
  await browser.execute(
    (id, text) => {
      const bridge = document.querySelector<LexicalInputE2EElement>(
        `[data-testid="${id}"]`,
      )?.__zcodeLexicalInputE2E;
      bridge?.setText(text);
      bridge?.focus();
    },
    TID_V4_COMPOSER_INPUT,
    PREFIX,
  );
  await browser.waitUntil(async () => (await editorText()) === PREFIX, {
    timeout: 5_000,
    timeoutMsg: "没有重置输入框",
  });
}

async function waitForEditorText(expected: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await editorText()) === expected, {
    timeout: 10_000,
    timeoutMsg: `${timeoutMsg}; latest=${JSON.stringify(await editorText())}`,
  });
}

async function runtimeLogText(): Promise<string> {
  const logs = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  if (!logs) throw new Error("缺少 worker 运行时日志目录");
  const names = (await readdir(logs)).filter((name) => name.endsWith(".log")).sort();
  return (await Promise.all(names.map((name) => readFile(join(logs, name), "utf8")))).join("\n");
}

/** 渲染层记录的最后一次采集总字节数（含 flush 出的尾块），来自运行时日志。 */
async function lastCapturedBytes(): Promise<number | null> {
  const text = await runtimeLogText();
  const matches = [...text.matchAll(/\[voice-input\] capture stopped .*?"bytes":(\d+)/gu)];
  return matches.length > 0 ? Number(matches.at(-1)![1]) : null;
}

/** 时间线里已发送的用户消息文本。 */
async function sentUserMessages(): Promise<string[]> {
  return (await getV4Messages("user")).map((message) => message.text);
}

async function releaseHeldCompletions() {
  await fetch(`${mockOrigin()}/__e2e/asr/release`, { method: "POST" });
}

/** 在新草稿里发送一条消息，得到一个真实会话并返回其 id。 */
async function createSession(seed: string): Promise<string> {
  await startNewV4Draft();
  await setV4ComposerText(seed);
  await clickV4Send();
  await waitForV4Pane(
    (snapshot) => Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
    `发送 ${seed} 后没有生成会话`,
    30_000,
  );
  return (await getV4PaneSnapshot()).sessionId!;
}

async function mockMicrophonePermission(status: "granted" | "denied") {
  const mock = await browser.electron.mock("systemPreferences", "getMediaAccessStatus");
  await mock.mockReturnValue(status);
}

async function startRecording() {
  await (await byId(TID_V4_COMPOSER_VOICE_INPUT)).click();
  await waitForVoiceState("recording", "点击麦克风后没有进入录音状态");
}

describe("Composer 语音输入", () => {
  let originalSettings: Awaited<ReturnType<typeof readSettings>>;

  before(async () => {
    await waitForDefaultWorkspaceReady(30_000);
    originalSettings = await readSettings();
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await browser.refresh();
    await waitForDefaultWorkspaceReady(30_000);
  });

  beforeEach(async () => {
    await resetMock({ kind: "normal", partial: "模拟临时", final: "你好世界" });
    await mockMicrophonePermission("granted");
    await byId(TID_V4_COMPOSER_VOICE_INPUT).waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "已登录桌面端没有显示语音输入按钮",
    });
    await resetEditor();
  });

  afterEach(async () => {
    await browser.keys("Escape");
    await browser.electron.restoreAllMocks();
  });

  after(async () => {
    await seedSettings(originalSettings);
  });

  it("VI-01: 识别结果直接写入光标处，结束后由最终文本替换且不自动发送", async () => {
    await startRecording();
    await waitForEditorText(`${PREFIX}模拟临时`, "录音中识别结果没有写入光标处");
    // 录音中显示音量点阵；假设备持续输出正弦音，点阵应出现有音量的点。
    const waveform = await byId(TID_V4_COMPOSER_VOICE_WAVEFORM);
    await waveform.waitForDisplayed({ timeout: 5_000, timeoutMsg: "录音中没有显示音量点阵" });
    await browser.waitUntil(
      async () => Number(await waveform.getAttribute("data-voice-active-dots")) > 0,
      { timeout: 5_000, timeoutMsg: "音量点阵没有随麦克风输入变化" },
    );
    const visual = await browser.execute(
      (buttonId, waveformId) => {
        const button = document.querySelector<HTMLElement>(`[data-testid="${buttonId}"]`)!;
        const wave = document.querySelector<HTMLElement>(`[data-testid="${waveformId}"]`)!;
        // 共享 Button 基础类本身带 aria-invalid:border-destructive，不能按类名判断；比较实际渲染颜色。
        const colorOf = (className: string) => {
          const probe = document.createElement("span");
          probe.className = className;
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        };
        const iconBlue = colorOf("bg-voice-input-wave");
        const accent = colorOf("bg-voice-input-surface");
        return {
          expandTransition: getComputedStyle(wave.parentElement!.parentElement!).transitionProperty,
          destructiveColors: [colorOf("bg-destructive"), colorOf("bg-destructive-surface")],
          buttonBackground: getComputedStyle(button).backgroundColor,
          stopColor: getComputedStyle(button.querySelector("span")!).backgroundColor,
          iconBlue,
          accent,
          pillBackground: getComputedStyle(button.parentElement!).backgroundColor,
          barColor: getComputedStyle(wave.firstElementChild!).backgroundColor,
          waveWidth: wave.getBoundingClientRect().width,
          buttonWidth: button.getBoundingClientRect().width,
        };
      },
      TID_V4_COMPOSER_VOICE_INPUT,
      TID_V4_COMPOSER_VOICE_WAVEFORM,
    );
    // 停止按钮是 ghost（点击后鼠标仍在按钮上，可能是 hover 底色），不使用 destructive 色；
    // 点阵不超过按钮宽度的 3 倍。
    expect(visual.destructiveColors).not.toContain(visual.buttonBackground);
    // 胶囊底色与波形、停止方块使用 DESIGN.md 的 sky 色系语音输入 token。
    expect(visual.stopColor).toBe(visual.iconBlue);
    expect(visual.barColor).toBe(visual.iconBlue);
    expect(visual.pillBackground).toBe(visual.accent);
    expect(visual.waveWidth).toBeLessThanOrEqual(visual.buttonWidth * 3);
    // 胶囊展开带宽度过渡，而不是直接出现。
    expect(visual.expandTransition).toContain("grid-template-columns");
    // 采集超过 300ms 才不会被判为说话时间太短。
    await browser.pause(1_000);
    await (await byId(TID_V4_COMPOSER_VOICE_INPUT)).click();
    await waitForVoiceState("idle", "识别完成后没有回到空闲");

    // 最终文本替换临时结果，而不是追加；输入框仍有内容说明没有自动发送。
    await waitForEditorText(`${PREFIX}你好世界`, "最终文本没有替换临时结果");
    expect(await byId(TID_V4_COMPOSER_VOICE_WAVEFORM).isExisting()).toBe(false);
    const state = await mockState();
    expect(state.ticketRequests).toHaveLength(1);
    expect(state.ticketRequests[0]!.authorization).toMatch(/^Bearer \S+/u);
    expect(JSON.parse(state.ticketRequests[0]!.body)).toEqual({ mode: "realtime" });
    const session = state.sessions[0]!;
    expect(session.start).toMatchObject({
      type: "start",
      audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1 },
      language: "zh-CN",
    });
    // 假设备持续输出音频；至少 1 秒 16kHz PCM16。
    expect(session.audioBytes).toBeGreaterThan(16_000);
    expect(session.audioBytes % 2).toBe(0);
    expect(session.controls).toEqual(["finish"]);
    // 尾块回归：停止时 flush 出的不足 100ms 音频也要发出，且全部在 finish 之前到达服务端。
    let capturedBytes: number | null = null;
    await browser.waitUntil(
      async () => {
        capturedBytes = await lastCapturedBytes();
        return capturedBytes !== null;
      },
      { timeout: 5_000, timeoutMsg: "运行时日志里没有采集统计" },
    );
    expect(session.audioBytesAtFinish).toBe(capturedBytes);
    expect(session.audioAfterFinish).toBe(0);
  });

  it("VI-02: 录音中按 Escape 取消并删除语音文字", async () => {
    await startRecording();
    await waitForEditorText(`${PREFIX}模拟临时`, "录音中识别结果没有写入");
    await browser.keys("Escape");
    await waitForVoiceState("idle", "Escape 后没有回到空闲");
    await browser.waitUntil(async () => (await mockState()).sessions[0]?.closed === true, {
      timeout: 5_000,
      timeoutMsg: "取消后服务端连接没有关闭",
    });
    expect((await mockState()).sessions[0]!.controls).toEqual(["cancel"]);
    expect(await editorText()).toBe(PREFIX);
  });

  it("VI-06: 录音中用户开始输入时与点击停止一致，最终文本替换语音文字且保留用户输入", async () => {
    await startRecording();
    await waitForEditorText(`${PREFIX}模拟临时`, "录音中识别结果没有写入");
    // 采集超过 300ms 才不会被判为说话时间太短。
    await browser.pause(1_000);
    await browser.keys("abc");
    await waitForVoiceState("idle", "用户输入后语音输入没有结束");
    // 走 finish 而不是 cancel：拿到服务端最终文本替换临时结果，用户在其后输入的字符保留。
    expect((await mockState()).sessions[0]!.controls).toEqual(["finish"]);
    await waitForEditorText(`${PREFIX}你好世界abc`, "最终文本没有替换临时结果或用户输入丢失");
  });

  it("VI-07: 录音中点击发送时先等最终文本，再发送最终文本", async () => {
    await startRecording();
    await waitForEditorText(`${PREFIX}模拟临时`, "录音中识别结果没有写入");
    await browser.pause(1_000);
    await (await byId(TID_V4_COMPOSER_SEND)).click();
    let sent: string[] = [];
    await browser.waitUntil(
      async () => {
        sent = await sentUserMessages();
        return sent.some((text) => text.includes(`${PREFIX}你好世界`));
      },
      {
        timeout: 15_000,
        timeoutMsg: `发送的消息不是语音识别的最终文本; sent=${JSON.stringify(sent)}`,
      },
    );
    expect((await mockState()).sessions[0]!.controls).toEqual(["finish"]);
    expect(sent.some((text) => text.includes("模拟临时"))).toBe(false);
  });

  it("VI-08: 等待识别结果期间切换会话，中止本次发送，不串会话", async () => {
    const sessionA = await createSession("VI08-A");
    const sessionB = await createSession("VI08-B");
    // B 有独立草稿：切回 B 时会恢复它。
    await setV4ComposerText("B草稿");
    await selectV4TaskById(sessionA);
    const userMessagesA = await sentUserMessages();

    await resetMock({
      kind: "normal",
      partial: "模拟临时",
      final: "切换后不应出现",
      holdFinal: true,
    });
    await resetEditor();
    await startRecording();
    await waitForEditorText(`${PREFIX}模拟临时`, "录音中识别结果没有写入");
    await browser.pause(1_000);
    await (await byId(TID_V4_COMPOSER_SEND)).click();
    // 服务端已收到 finish，但最终结果被扣住：发送正在等待识别。
    await browser.waitUntil(
      async () => (await mockState()).sessions[0]?.controls.includes("finish") === true,
      { timeout: 5_000, timeoutMsg: "点击发送后没有发出 finish" },
    );

    await selectV4TaskById(sessionB);
    await releaseHeldCompletions();
    await browser.pause(1_500);
    // 旧提交恢复后识别出目标已变化并中止（不靠后续守卫碰巧拦下）。
    expect(await runtimeLogText()).toContain("[voice-input] submit aborted");
    // B：草稿仍在，没有收到 A 的内容，也没有被发送清空。
    expect(await editorText()).toBe("B草稿");
    expect(await sentUserMessages()).toEqual(
      expect.not.arrayContaining([expect.stringContaining("B草稿")]),
    );

    await selectV4TaskById(sessionA);
    // A：切走后没有发生提交；临时语音文字留在 A 的草稿里。先等时间线加载完。
    await browser.waitUntil(async () => (await sentUserMessages()).length > 0, {
      timeout: 15_000,
      timeoutMsg: "切回 A 后时间线没有加载",
    });
    expect(await sentUserMessages()).toEqual(userMessagesA);
    await waitForEditorText(`${PREFIX}模拟临时`, "A 的草稿没有保留临时语音文字");
  });

  it("VI-09: 首个识别结果前用户已开始输入，最终文本插在录音开始处且不移动光标", async () => {
    await resetMock({ kind: "normal", partial: "", final: "你好世界" });
    await startRecording();
    await browser.pause(1_000);
    await browser.keys("abc");
    await waitForVoiceState("idle", "用户输入后语音输入没有结束");
    await waitForEditorText(`${PREFIX}你好世界abc`, "最终文本没有插在录音开始处");
    // 光标仍在用户输入的 abc 之后：继续输入的字符紧跟 abc。
    await browser.keys("d");
    await waitForEditorText(`${PREFIX}你好世界abcd`, "最终文本写入后光标被移动");
  });

  it("VI-10: 首个识别结果前用户在录音开始点之前输入，开始点失效，最终文本追加到末尾", async () => {
    await resetMock({ kind: "normal", partial: "", final: "你好世界" });
    await startRecording();
    await browser.pause(1_000);
    // 光标移到行首再输入：录音开始点（「前缀」之后）前面的内容变了，旧 offset 不能再用。
    // 用 DOM 选区把光标移到行首：macOS 下 WebDriver 发出的 Cmd+← 不会移动 contenteditable 光标。
    await browser.execute((id) => {
      const root = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode();
      if (first) window.getSelection()?.collapse(first, 0);
    }, TID_V4_COMPOSER_INPUT);
    await browser.pause(100);
    await browser.keys("ab");
    await waitForVoiceState("idle", "用户输入后语音输入没有结束");
    // 不拆开「前缀」，按 spec 追加到末尾；光标仍在用户输入的 ab 之后。
    await waitForEditorText(`ab${PREFIX}你好世界`, "开始点失效时最终文本没有追加到末尾");
    await browser.keys("c");
    await waitForEditorText(`abc${PREFIX}你好世界`, "最终文本写入后光标被移动");
  });

  it("VI-11: 等待识别期间新增附件，随消息发出并在发送后从输入框清除", async () => {
    // 从新草稿开始：之前用例的会话可能仍有进行中的回合，语音消息会进入队列而不出现在时间线上。
    await startNewV4Draft();
    await resetMock({ kind: "normal", partial: "模拟临时", final: "你好世界", holdFinal: true });
    await resetEditor();
    await startRecording();
    await waitForEditorText(`${PREFIX}模拟临时`, "录音中识别结果没有写入");
    await browser.pause(1_000);
    await (await byId(TID_V4_COMPOSER_SEND)).click();
    await browser.waitUntil(
      async () => (await mockState()).sessions[0]?.controls.includes("finish") === true,
      { timeout: 5_000, timeoutMsg: "点击发送后没有发出 finish" },
    );
    // 发送正在等待识别：此时新增一个附件，并等它上传就绪。
    await pasteV4ComposerFileAttachment("vi11-added.png");
    await $("[data-composer-attachment-remove]").waitForExist({
      timeout: 15_000,
      timeoutMsg: "附件没有出现在输入框",
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelector(
              '[data-composer-file-attachments-row="true"] [aria-busy="true"]',
            ) === null,
        ),
      { timeout: 15_000, timeoutMsg: "附件没有上传就绪" },
    );
    await releaseHeldCompletions();

    let sent: { id: string | null; text: string } | undefined;
    await browser.waitUntil(
      async () => {
        sent = (await getV4Messages("user")).find((message) =>
          message.text.includes(`${PREFIX}你好世界`),
        );
        return sent !== undefined;
      },
      { timeout: 15_000, timeoutMsg: "没有发出语音最终文本" },
    );
    // 附件属于本次发送：消息带上它，发送后输入框里不再残留。
    expect(await waitForV4RowAttachments(15_000, ["vi11-added.png"])).toContain("vi11-added.png");
    await browser.waitUntil(
      async () => !(await $("[data-composer-attachment-remove]").isExisting()),
      { timeout: 5_000, timeoutMsg: "发送后附件仍残留在输入框里" },
    );
  });

  it("VI-12: 用户在语音文字后追加输入再按 Escape，只删除语音文字，保留用户输入", async () => {
    await resetMock({ kind: "normal", partial: "模拟临时", final: "迟到结果", holdFinal: true });
    await startRecording();
    await waitForEditorText(`${PREFIX}模拟临时`, "录音中识别结果没有写入");
    await browser.pause(1_000);
    // 光标在语音文字末尾：追加的字符进入同一个文本节点，录音进入识别中。
    await browser.keys("abc");
    await waitForEditorText(`${PREFIX}模拟临时abc`, "用户输入没有写入");
    await waitForVoiceState("finishing", "用户输入后没有进入识别中");
    await browser.keys("Escape");
    await waitForVoiceState("idle", "Escape 后没有回到空闲");
    await waitForEditorText(`${PREFIX}abc`, "Escape 后语音文字没有删除，或用户输入丢失");
    await browser.waitUntil(
      async () => (await mockState()).sessions[0]?.controls.includes("cancel") === true,
      { timeout: 5_000, timeoutMsg: "Escape 后服务端没有收到 cancel" },
    );
    // 迟到的最终结果不能再写回输入框。
    await releaseHeldCompletions();
    await browser.pause(1_000);
    expect(await editorText()).toBe(`${PREFIX}abc`);
    // 光标仍在 abc 之后。
    await browser.keys("d");
    await waitForEditorText(`${PREFIX}abcd`, "删除语音文字后光标位置不对");
  });

  it("VI-03: 服务端繁忙时提示稍后再试", async () => {
    await resetMock({ kind: "ticket-error", status: 429, errorCode: "rate_limited" });
    await (await byId(TID_V4_COMPOSER_VOICE_INPUT)).click();
    await waitForToastContaining("语音识别繁忙，请稍后再试", "限流后没有提示");
    await waitForVoiceState("idle", "限流后没有回到空闲");
    expect((await mockState()).sessions).toHaveLength(0);
  });

  it("VI-04: 服务端返回空文本时提示没有识别到内容", async () => {
    await resetMock({ kind: "empty-final" });
    await startRecording();
    await browser.pause(1_000);
    const before = await editorText();
    await (await byId(TID_V4_COMPOSER_VOICE_INPUT)).click();
    await waitForToastContaining("没有识别到内容", "空结果后没有提示");
    expect(await editorText()).toBe(before);
  });

  it("VI-05: 系统拒绝麦克风权限时，toast 按钮打开系统麦克风设置", async function () {
    if (process.platform === "linux") this.skip();
    await browser.electron.restoreAllMocks();
    await mockMicrophonePermission("denied");
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockResolvedValue(undefined);

    await (await byId(TID_V4_COMPOSER_VOICE_INPUT)).click();
    await waitForToastContaining("没有麦克风权限", "权限被拒后没有提示");
    // 系统权限被拒时不申请 ticket。
    expect((await mockState()).ticketRequests).toHaveLength(0);
    await browser.execute(() => {
      const host = document.querySelector("#zcode-toast-host");
      const button = Array.from(host?.querySelectorAll("button") ?? []).find((element) =>
        element.textContent?.includes("打开系统设置"),
      );
      (button as HTMLButtonElement | undefined)?.click();
    });
    const expectedUrl =
      process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        : "ms-settings:privacy-microphone";
    await browser.waitUntil(
      async () => {
        try {
          await expect(openExternal).toHaveBeenCalledWith(expectedUrl);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 5_000, timeoutMsg: `没有打开 ${expectedUrl}; toasts=${await getToastMessages()}` },
    );
  });

  // Host 网络 transport 只在启动时读取代理设置，所以这组用例要重启应用；放在最后，结束时恢复原代理设置。
  describe("经 HTTP 代理", () => {
    let proxy: Awaited<ReturnType<typeof startAsrFrameDroppingProxy>>;
    let originalNetwork: { httpProxy?: string; httpProxyNoProxy?: string };

    const restartWithNetwork = async (network: {
      httpProxy?: string;
      httpProxyNoProxy?: string;
    }) => {
      await reloadElectronSessionSafely(browser, {
        afterElectronProcessExit: async () => {
          await seedSettings(network);
        },
      });
      // 重启后恢复上次会话，活动工作区不一定是默认工作区；这组用例只需要 Composer 与语音按钮。
      await byId(TID_V4_COMPOSER_VOICE_INPUT).waitForDisplayed({
        timeout: 30_000,
        timeoutMsg: "重启后没有显示语音输入按钮",
      });
    };

    /** 本次点击之后新增的 Host 失败日志（按出现顺序） */
    const failureLogsSince = async (before: number) =>
      [...(await runtimeLogText()).matchAll(/voice input failed (\{.*\})/gu)]
        .slice(before)
        .map((match) => JSON.parse(match[1]!) as Record<string, unknown>);

    before(async () => {
      proxy = await startAsrFrameDroppingProxy();
      // capture 模式会预设代理（No Proxy 含 127.0.0.1），结束时按原值恢复。
      const { httpProxy, httpProxyNoProxy } = await readSettings();
      originalNetwork = { httpProxy, httpProxyNoProxy };
      // httpProxyNoProxy 不能写空字符串（schema 要求非空，否则整份设置回退默认值），用 undefined 删除。
      await restartWithNetwork({ httpProxy: proxy.url, httpProxyNoProxy: undefined });
    });

    after(async () => {
      await restartWithNetwork(originalNetwork);
      await proxy.close();
    });

    it("VI-13: 代理在握手后丢弃 WS 数据帧，提示代理问题并记录握手结果", async () => {
      const before = (await failureLogsSince(0)).length;
      await (await byId(TID_V4_COMPOSER_VOICE_INPUT)).click();
      await waitForToastContaining(
        "无法通过 HTTP 代理连接语音识别服务",
        "代理断开后没有提示代理问题",
      );
      await waitForVoiceState("idle", "代理断开后没有回到空闲");
      // ticket 经代理成功；WS 握手经代理完成，start 被代理丢弃，服务端没有收到。
      expect(proxy.upgradedSockets).toBe(1);
      const state = await mockState();
      expect(state.ticketRequests).toHaveLength(1);
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0]?.start).toBeUndefined();
      expect(await runtimeLogText()).toMatch(/voice input socket open .*"viaProxy":true/u);
      // 同一行可能出现在多个日志文件里，取本次点击后最新一条。
      expect((await failureLogsSince(before)).at(-1)).toMatchObject({
        code: "proxy",
        stage: "socket",
        opened: true,
        viaProxy: true,
        closeCode: 1006,
        wasClean: false,
      });
    });

    it("VI-14: 服务端在握手阶段拒绝时提示通用失败，不归为代理问题", async () => {
      await resetMock({ kind: "ws-reject", status: 403 });
      const upgradedBefore = proxy.upgradedSockets;
      const before = (await failureLogsSince(0)).length;
      await (await byId(TID_V4_COMPOSER_VOICE_INPUT)).click();
      await waitForToastContaining("语音识别失败，请重试", "握手被拒后没有提示通用失败");
      await waitForVoiceState("idle", "握手被拒后没有回到空闲");
      // 握手没有成功：代理只转发了 403，没有进入丢帧，服务端也没有建立会话。
      expect(proxy.upgradedSockets).toBe(upgradedBefore);
      expect((await mockState()).sessions).toHaveLength(0);
      // 上一个用例的代理 toast 可能仍在，分类以 Host 日志为准。
      await browser.waitUntil(async () => (await failureLogsSince(before)).length > 0, {
        timeout: 5_000,
        timeoutMsg: "握手被拒后 Host 没有记录失败",
      });
      expect((await failureLogsSince(before)).at(-1)).toMatchObject({
        code: "failed",
        stage: "handshake",
        opened: false,
        viaProxy: true,
      });
    });
  });
});
