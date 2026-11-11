// HK16（catalog HK 组）：PermissionRequest hook 与审批交互竞速（permission-responder-race）。
// 事故回归（2026-08-26）：同步 PermissionRequest command hook 阻塞等待外部应答时，
// 旧时序把 broker 应答通道的注册串行排在 hook 链之后，确认窗虽可见但用户批准被
// resolveInteraction 幂等语义静默丢弃 → turn 永久挂起。修复后 hook 链与 broker
// 并发竞速，先到者胜。spec：apps/zcode-cli/docs/design/v2/permission-responder-race.md。
import { readFile, mkdir, rm } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "#e2e/helpers/e2e-runtime-paths";
import {
  installPermissionHookRaceFixture,
  PERMISSION_HOOK_RACE_FINAL_MARKER,
  PERMISSION_HOOK_RACE_MARKER,
  PERMISSION_HOOK_RACE_RESULT_CONTENT,
  readPermissionHookRaceTrace,
  restorePermissionHookRaceFixture,
  waitForBlockingHookStarted,
} from "#e2e/helpers/permission-hook-race-fixture";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PERMISSION_HOOK_RACE_CASE = "conversation-session-permission-hook-race";
const PERMISSION_HOOK_RACE_DIR = resolveE2ERuntimePath(PERMISSION_HOOK_RACE_CASE);
const PERMISSION_HOOK_RACE_OUTPUT_PATH = resolveE2EToolPath(
  PERMISSION_HOOK_RACE_CASE,
  "write-output.txt",
);

describe("PermissionRequest hook 与审批交互竞速", () => {
  before(async function () {
    this.timeout(120000);
    await rm(PERMISSION_HOOK_RACE_DIR, { recursive: true, force: true });
    await mkdir(PERMISSION_HOOK_RACE_DIR, { recursive: true });
    await installPermissionHookRaceFixture();
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await restorePermissionHookRaceFixture();
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(PERMISSION_HOOK_RACE_DIR, { recursive: true, force: true });
  });

  it("HK16: 阻塞的 PermissionRequest hook 不再挡住确认窗应答，用户批准先到者胜", async function () {
    this.timeout(180000);

    await sendV4Prompt(
      `${PERMISSION_HOOK_RACE_MARKER} 请写入文件 ${PERMISSION_HOOK_RACE_OUTPUT_PATH}`,
    );

    // 反向权限请求 → 确认窗渲染（emitPermissionRequested 已发出）。
    const dockState = await waitForV4PermissionDialogInComposerDock();
    expect(dockState.inDock).toBe(true);
    expect(dockState.composerHidden).toBe(true);

    // 竞速前提：阻塞 hook 已真实启动（否则本 case 退化为普通审批，空洞通过）。
    await waitForBlockingHookStarted();

    // 事故断言点：hook 仍阻塞（120s 睡眠远未结束）时，批准必须立即收口，
    // 而不是被 resolveInteraction 按 no-pending-interaction 静默丢弃。
    const dismissed = await approveV4Permission();
    expect(dismissed).toBe(true);

    // broker 胜出 → 工具按原输入执行 → tool_result 回灌 → 60s 内出终态文本。
    // 旧时序下 turn 要等 hook 睡满/超时才可能推进，此处必然超时失败。
    await waitForV4TimelineContaining(PERMISSION_HOOK_RACE_FINAL_MARKER, 60000);

    expect(await readFile(PERMISSION_HOOK_RACE_OUTPUT_PATH, "utf8")).toBe(
      PERMISSION_HOOK_RACE_RESULT_CONTENT,
    );

    // hook 是败者：只 started 一次、从未产出决定（settled-without-decision
    // 只有睡满 120s 才会出现）。aborted 记录依赖 POSIX 信号，跨平台不作断言。
    const trace = await readPermissionHookRaceTrace();
    expect(trace.filter((record) => record.phase === "started")).toHaveLength(1);
    expect(trace.some((record) => record.phase === "settled-without-decision")).toBe(false);
  });
});
