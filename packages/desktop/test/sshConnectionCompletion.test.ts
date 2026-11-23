import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSSHProjectDirectoryStep, waitForSSHDirectoryStep } from "#e2e/helpers/ssh-remote-p0";

vi.mock("#e2e/helpers/desktop-app", () => ({}));
vi.mock("#e2e/helpers/custom-openai-provider-store", () => ({}));
vi.mock("#e2e/helpers/v4-conversation", () => ({
  startNewV4Draft: vi.fn(() => {
    throw new Error("当前项目选择流程仍在进行，不应新建草稿并重开向导");
  }),
}));

type Step =
  | "install"
  | "connecting"
  | "directory"
  | "project-form"
  | "closing-form"
  | "project-picker"
  | "project-picker-loading"
  | "project-picker-error"
  | "closed"
  | "error"
  | "updating"
  | "unexpected-confirm";

function installBrowserFixture(initialStep: Step, followingSteps: Step[] = []) {
  let step = initialStep;
  const install = {
    textContent: "Install and continue",
    disabled: false,
    getClientRects: () => [1],
    click: vi.fn(() => {
      step = "closed";
    }),
  };
  const dialog = { querySelectorAll: () => (step === "install" ? [install] : []) };
  const confirmation = {
    disabled: false,
    getClientRects: () => [1],
    closest: () => ({ dataset: { confirmIntent: "source-server-force-update" } }),
    click: vi.fn(),
  };
  const document = {
    querySelectorAll: () =>
      ["project-form", "closing-form"].includes(step)
        ? [
            {
              closest: () => ({
                getAttribute: () => (step === "project-form" ? "open" : "closed"),
              }),
            },
          ]
        : [],
    querySelector: (selector: string) => {
      if (selector === '[data-testid="ssh-dialog"]')
        return [
          "closed",
          "project-picker",
          "project-picker-loading",
          "project-picker-error",
        ].includes(step)
          ? null
          : dialog;
      if (selector === '[data-testid="remote-project-new"]' && step.startsWith("project-picker"))
        return {
          disabled: step !== "project-picker",
          closest: () => ({
            querySelector: () =>
              step === "project-picker-error"
                ? {
                    getClientRects: () => [1],
                    innerText: "SourceServerWorkspaceIdentityConflictError: /work",
                  }
                : null,
          }),
        };
      if (selector === '[data-testid="ssh-success"]' && step === "directory") {
        return { getClientRects: () => [1] };
      }
      if (selector === '[data-testid="ssh-error"]' && ["error", "updating"].includes(step)) {
        return {
          getClientRects: () => [1],
          innerText: step === "updating" ? "Updating\nCancel connection" : "Authentication failed",
        };
      }
      if (
        selector === '[data-testid="ssh-dialog"] [data-remote-connection-status="connecting"]' &&
        step === "updating"
      ) {
        return { getClientRects: () => [1] };
      }
      if (selector === '[data-testid="confirm-dialog-confirm"]' && step === "unexpected-confirm") {
        return confirmation;
      }
      return null;
    },
  };
  const waitUntil = vi.fn(
    async (predicate: () => Promise<boolean>, options: { timeoutMsg: string }) => {
      // 虚拟轮询只控制浏览器边界；独立 VM 执行实际 helper 回调，避免复制被测状态机。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await predicate()) return;
        step = followingSteps.shift() ?? step;
      }
      throw new Error(options.timeoutMsg);
    },
  );
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      runInNewContext(`(${fn.toString()})(...args)`, { document, args }),
    waitUntil,
  });
  return { install, confirmation };
}

afterEach(() => vi.unstubAllGlobals());

describe("SSH 连接完成等待", () => {
  it("向导实际关闭且没有项目选择页时返回 closed", async () => {
    installBrowserFixture("closed");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).resolves.toBe("closed");
  });

  it("首装确认后向导关闭也能完成", async () => {
    const { install } = installBrowserFixture("install");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).resolves.toBe("closed");
    expect(install.click).toHaveBeenCalledOnce();
  });

  it("目录页仍返回独立的 directory 完成态", async () => {
    installBrowserFixture("directory");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).resolves.toBe("directory");
  });

  it("项目选择页替换连接向导后继续当前流程，不再打开被遮挡的侧栏", async () => {
    installBrowserFixture("project-picker");
    await expect(
      ensureSSHProjectDirectoryStep(
        { host: "127.0.0.1", port: 43210, username: "dev", password: "fixture" },
        "E2E_SSH_COMPLETION",
      ),
    ).resolves.toBeUndefined();
  });

  it("项目列表尚在加载时不把连接向导消失当作完成", async () => {
    installBrowserFixture("project-picker-loading");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).rejects.toThrow(
      "SSH 部署/连接没有完成",
    );
  });

  it("连接中不提前宣告成功", async () => {
    installBrowserFixture("connecting");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).rejects.toThrow(
      "SSH 部署/连接没有完成",
    );
  });

  it("项目列表错误立即带出原始原因，不等待被错误禁用的新项目按钮", async () => {
    installBrowserFixture("project-picker-error");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).rejects.toThrow(
      "SourceServerWorkspaceIdentityConflictError: /work",
    );
  });

  it("连接错误直接携带原始原因失败", async () => {
    installBrowserFixture("error");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).rejects.toThrow(
      "SSH 连接失败: Authentication failed",
    );
  });

  it("升级期间的错误面板继续等待，目录入口就绪后才完成", async () => {
    installBrowserFixture("updating", ["updating", "directory"]);
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).resolves.toBe("directory");
  });

  it("升级失败后仍立即报告错误", async () => {
    installBrowserFixture("updating", ["error"]);
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).rejects.toThrow(
      "SSH 连接失败: Authentication failed",
    );
  });

  it("升级一直未结束时保留原有部署超时边界", async () => {
    installBrowserFixture("updating");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).rejects.toThrow(
      "SSH 部署/连接没有完成",
    );
  });

  it("不确认安装和边界提示以外的动作", async () => {
    const { confirmation } = installBrowserFixture("unexpected-confirm");
    await expect(waitForSSHDirectoryStep("E2E_SSH_COMPLETION")).rejects.toThrow(
      "unexpected confirmation intent: source-server-force-update",
    );
    expect(confirmation.click).not.toHaveBeenCalled();
  });
});

it("已有设备连接完成回到打开的项目表单，目录意图可以继续", async () => {
  installBrowserFixture("project-form");
  await expect(waitForSSHDirectoryStep("E2E_PROJECT_FORM")).resolves.toBe("directory");
});
it("原表单正在收起时不把未完成连接误判为完成", async () => {
  installBrowserFixture("closing-form");
  await expect(waitForSSHDirectoryStep("E2E_PROJECT_FORM")).rejects.toThrow(
    "SSH 部署/连接没有完成",
  );
});
