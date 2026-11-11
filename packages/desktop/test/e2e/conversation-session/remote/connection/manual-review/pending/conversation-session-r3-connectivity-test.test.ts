import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_MODEL_PROVIDER_MODEL_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { getUpstreamRequestRecordCount } from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { readRemoteTabSnapshot, runSSHCommand } from "#e2e/helpers/ssh-remote-p0";
import { selectV4TaskById } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_CONNECTIVITY_TEST";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-connectivity-test",
);

async function openModelProviderSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 没有设置入口`,
  });
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有模型供应商分区`,
  });
}

/** 在设置页选中目标 provider 卡片后点“测试模型”按钮（title 文案），返回随后出现的提示文本。 */
async function runConnectivityTest(
  providerName: string,
  modelId: string,
): Promise<{ clicked: boolean; toast: string }> {
  await browser.waitUntil(
    () =>
      browser.execute((name) => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>(
            "button, a, [role='button'], [role='treeitem'], li",
          ),
        ).find((node) => node.innerText.trim() === name && node.getClientRects().length);
        item?.click();
        return Boolean(item);
      }, providerName),
    {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: `${CASE_MARKER}: 设置页没有 provider ${providerName}`,
    },
  );
  // 反馈按 provider/model 去重；先关闭上一条结果，避免新调用被旧的“连接成功”满足。
  await browser.execute((provider) => {
    for (const item of document.querySelectorAll<HTMLElement>(
      "[data-provider-detail-feedback-state]",
    )) {
      if (item.innerText.includes(provider))
        item.querySelector<HTMLButtonElement>("button")?.click();
    }
  }, providerName);
  await browser.waitUntil(
    () =>
      browser.execute(
        (provider) =>
          !Array.from(
            document.querySelectorAll<HTMLElement>("[data-provider-detail-feedback-state]"),
          ).some((item) => item.innerText.includes(provider)),
        providerName,
      ),
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 上一次模型测试反馈没有关闭` },
  );
  let clicked = false;
  await browser.waitUntil(
    async () => {
      clicked = await browser.execute(
        (model, prefix) => {
          const label = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`),
          ).find((node) => node.textContent?.trim() === model && node.getClientRects().length);
          if (!label) return false;
          let row = label.parentElement;
          while (row) {
            const button = Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find(
              (item) => item.title === "测试模型",
            );
            if (button) {
              if (button.disabled) return false;
              button.click();
              return true;
            }
            row = row.parentElement;
          }
          return false;
        },
        modelId,
        TID_MODEL_PROVIDER_MODEL_INPUT,
      );
      return clicked;
    },
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 找不到目标模型 ${modelId} 的测试按钮` },
  );
  let toast = "";
  await browser.waitUntil(
    async () => {
      toast = await browser.execute(
        (provider, model) =>
          Array.from(
            document.querySelectorAll<HTMLElement>("[data-provider-detail-feedback-state]"),
          )
            .filter(
              (item) =>
                item.getClientRects().length &&
                item.dataset.providerDetailFeedbackState !== "pending" &&
                item.innerText.includes(provider) &&
                item.innerText.includes(model),
            )
            .map((item) => item.innerText.trim())
            .join(" | "),
        providerName,
        modelId,
      );
      return toast.length > 0;
    },
    {
      timeout: 60_000,
      interval: 200,
      timeoutMsg: `${CASE_MARKER}: 目标模型没有产生本次测试的终态反馈`,
    },
  );
  return { clicked, toast };
}

describe(`${CASE_MARKER}: 激活远端 workspace 时模型设置连通性测试的执行位置`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "connectivity-test.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-PRV-17 有本地 workspace 时在本地执行（回放收到请求、远端日志无）；无本地页签与记忆路径时用本机对话目录在本地执行；Linux 路径不交给本机 Agent", async function () {
    this.timeout(25 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    await selectV4TaskById(taskA.taskId);
    const remoteLogBefore = await runSSHCommand(
      prepared.config,
      'F=$(ls -t ~/.zcode/cli/log/*.jsonl | head -n1); grep -c "model.network" "$F" || true',
    );

    // ① 远端 workspace 激活 + 本地默认 workspace tab 存在：测试 Upstream E2E（本机回放可达）→ 本地执行。
    const requestsBefore = await getUpstreamRequestRecordCount();
    await openModelProviderSettings();
    const withLocal = await runConnectivityTest("Upstream E2E", "deepseek-v4-flash");
    await browser.pause(2_000);
    const requestsAfter = await getUpstreamRequestRecordCount();
    const remoteLogAfter = await runSSHCommand(
      prepared.config,
      'F=$(ls -t ~/.zcode/cli/log/*.jsonl | head -n1); grep -c "model.network" "$F" || true',
    );
    facts.withLocalWorkspace = {
      ...withLocal,
      localReplayRequestsDelta: requestsAfter - requestsBefore,
      remoteModelNetworkDelta:
        Number.parseInt(remoteLogAfter.stdout.trim() || "0", 10) -
        Number.parseInt(remoteLogBefore.stdout.trim() || "0", 10),
    };
    expect(withLocal.clicked).toBe(true);
    expect(requestsAfter - requestsBefore).toBeGreaterThanOrEqual(1);
    expect(withLocal.toast).toMatch(/连接成功/u);
    expect(
      (facts.withLocalWorkspace as { remoteModelNetworkDelta: number }).remoteModelNetworkDelta,
    ).toBe(0);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页返回按钮没有出现`,
    });

    // ② 构造真正没有本地候选的 fixture：关闭本地 workspace，并清除远程 tab 保留的本地来源路径。
    // 只关闭页签仍可合法使用 localWorkspacePath；不能据此把正确的本机请求当作业务回归。
    const closedLocal = await browser.execute((localPath) => {
      const store = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState?: () => {
              tabs?: Array<{
                id: string;
                kind?: string;
                workspacePath?: string;
                workspaceIdentity?: string;
                remoteSessionId?: string;
              }>;
              closeTab?: (id: string, origin: "user-close") => void;
            };
          };
        }
      ).__zcodeTabStoreE2E;
      const state = store?.getState?.();
      const locals = (state?.tabs ?? []).filter(
        (tab) => tab.kind === "workspace" && !tab.workspaceIdentity && !tab.remoteSessionId,
      );
      for (const tab of locals) state?.closeTab?.(tab.id, "user-close");
      return {
        closed: locals.length,
        remaining: (store?.getState?.().tabs ?? []).map((tab) => tab.workspacePath ?? ""),
        localPath,
      };
    }, DEFAULT_WORKSPACE);
    facts.closedLocalTabs = closedLocal;
    await browser.pause(1_500);
    await selectV4TaskById(taskA.taskId);
    const routingFixture = await browser.execute((identity) => {
      type Tab = {
        id: string;
        kind: string;
        workspacePath?: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
        localWorkspacePath?: string;
      };
      const store = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState(): { tabs: Tab[]; activeWorkspaceIdentity?: string | null };
            setState(patch: { tabs: Tab[] }): void;
          };
        }
      ).__zcodeTabStoreE2E;
      if (!store) throw new Error("缺少 TabStore fixture bridge");
      const state = store.getState();
      const remote = state.tabs.find((tab) => tab.workspaceIdentity === identity);
      if (!remote || state.activeWorkspaceIdentity !== identity)
        throw new Error("远程 workspace 未激活");
      const localTabs = state.tabs.filter(
        (tab) => tab.kind === "workspace" && !tab.workspaceIdentity && !tab.remoteSessionId,
      );
      if (localTabs.length) throw new Error("仍存在本地 workspace，负例前置未建立");
      store.setState({
        tabs: state.tabs.map((tab) =>
          tab.workspaceIdentity === identity ? { ...tab, localWorkspacePath: undefined } : tab,
        ),
      });
      return {
        activeIdentity: identity,
        previousLocalPath: remote.localWorkspacePath ?? null,
        localTabCount: localTabs.length,
      };
    }, taskA.identity);
    facts.withoutLocalRoutingFixture = routingFixture;
    const requestsBefore2 = await getUpstreamRequestRecordCount();
    await openModelProviderSettings();
    const withoutLocal = await runConnectivityTest("Upstream E2E", "deepseek-v4-flash");
    await browser.pause(2_000);
    const requestsAfter2 = await getUpstreamRequestRecordCount();
    const remoteLogAfter2 = await runSSHCommand(
      prepared.config,
      'F=$(ls -t ~/.zcode/cli/log/*.jsonl | head -n1); grep -c "model.network" "$F" || true',
    );
    facts.withoutLocalWorkspace = {
      ...withoutLocal,
      localReplayRequestsDelta: requestsAfter2 - requestsBefore2,
      remoteModelNetworkDelta:
        Number.parseInt(remoteLogAfter2.stdout.trim() || "0", 10) -
        Number.parseInt(remoteLogAfter.stdout.trim() || "0", 10),
    };
    // ZCT-2112556538453495808：只开远程项目时旧逻辑报“本地工作区不可用”；现在由本机 Host
    // 的对话目录承接测试，请求仍只到本机回放，远端没有模型请求。
    expect(withoutLocal.clicked).toBe(true);
    expect(withoutLocal.toast).toMatch(/连接成功/u);
    expect(requestsAfter2 - requestsBefore2).toBeGreaterThanOrEqual(1);
    expect(
      (facts.withoutLocalWorkspace as { remoteModelNetworkDelta: number }).remoteModelNetworkDelta,
    ).toBe(0);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页返回按钮没有出现`,
    });
    expect((await readRemoteTabSnapshot(taskA.identity)).remoteSessionId).toBe(
      taskA.remoteSessionId,
    );
  });
});
