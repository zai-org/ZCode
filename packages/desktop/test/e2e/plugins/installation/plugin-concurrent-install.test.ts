import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  addMarketplaceSourceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  getPluginList,
  getPluginOverview,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginCard,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

const marketplace = "e2e-concurrent-install";
const names = ["first", "second"];
const localName = "local";
const localSkill = "detail-during-install";

describe("PLM-CONCURRENT-INSTALL 独立安装忙碌态", () => {
  it("后一次安装与前一次失败都不能清理另一插件的安装中状态", async function () {
    this.timeout(240000);
    requirePluginManualReview();
    const gate = await startGatedZipServer();
    try {
      await prepareGatedMarketplace(gate.port);
      await clickPluginControl("plugin-store-install", { pluginId: `first@${marketplace}` });
      await browser.waitUntil(() => gate.pending.has("first"), { timeout: 30000 });
      await clickPluginControl("plugin-store-install", { pluginId: `second@${marketplace}` });
      await assertBusy([true, true]);
      await capturePluginManualReview("PLM-CONCURRENT-INSTALL", "both-pending");
      // PLM-DETAIL-DURING-INSTALL：A 下载中、B 排在 A 后面时打开其他插件详情。
      // 旧实现中 describe 排在两次安装后面，组件区会一直停在 loading。
      await openPluginCard(`${localName}@${marketplace}`);
      await waitForPluginControl(
        "plugin-store-component-section",
        { componentKind: "skill" },
        30000,
      );
      if (!gate.pending.has("first")) throw new Error("Install finished before detail loaded");
      await capturePluginManualReview("PLM-DETAIL-DURING-INSTALL", "detail-loaded");
      // 新建右侧标签页会新建插件 store 并加载 list/overview；旧实现中它们排在两次安装后面，
      // 推荐区一直停在骨架屏。这里直接走同一条服务链路，断言安装未结束时就返回。
      await withTimeout(
        Promise.all([getPluginList(), getPluginOverview()]),
        10000,
        "plugins/list and plugins/overview waited for the install",
      );
      if (!gate.pending.has("first")) throw new Error("Install finished before list loaded");
      await clickPluginControl("plugin-store-detail-back");
      await assertBusy([true, true]);
      gate.release("first");
      await browser.waitUntil(() => gate.pending.has("second"), { timeout: 60000 });
      await assertBusy([false, true]);
      gate.release("second");
      await assertBusy([false, false]);
    } finally {
      await gate.close();
      await clearAppData();
    }
  });
});

// 用响应门控制真实下载，不依赖网络速度或固定 sleep 制造并发窗口。
async function startGatedZipServer() {
  const pending = new Map<string, ServerResponse[]>();
  const released = new Set<string>();
  const server = createServer((request, response) => {
    const name = request.url?.slice(1).replace(".zip", "") ?? "";
    if (released.has(name)) {
      response.writeHead(404).end("fixture install failure");
    } else {
      pending.set(name, [...(pending.get(name) ?? []), response]);
    }
  });
  const release = (name: string) => {
    released.add(name);
    for (const response of pending.get(name) ?? []) {
      response.writeHead(404).end("fixture install failure");
    }
    pending.delete(name);
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  return {
    pending,
    port: address.port,
    release,
    async close() {
      for (const name of names) release(name);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function prepareGatedMarketplace(port: number): Promise<void> {
  const fixture = join(getE2EAppDataPaths().homeDir, "fixtures", marketplace);
  await mkdir(join(fixture, ".claude-plugin"), { recursive: true });
  const skillDir = join(fixture, "plugins", localName, "skills", localSkill);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${localSkill}\ndescription: Detail stays readable during install\n---\n`,
  );
  await writeFile(
    join(fixture, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: marketplace,
      plugins: [
        ...names.map((name) => ({
          name,
          version: "1.0.0",
          description: `Concurrent install ${name}`,
          source: {
            source: "url",
            type: "zip",
            url: `http://127.0.0.1:${port}/${name}.zip`,
            sha256: "0".repeat(64),
          },
        })),
        {
          name: localName,
          version: "1.0.0",
          description: "Local detail fixture",
          source: `./plugins/${localName}`,
        },
      ],
    }),
  );
  await openPluginSettings();
  await addMarketplaceSourceThroughUi(fixture);
  await clickPluginControl("plugin-store-segment-personal");
  for (const name of [...names, localName])
    await waitForPluginCard(`${name}@${marketplace}`, 60000);
}

async function assertBusy(expected: boolean[]): Promise<void> {
  await browser.waitUntil(
    async () => {
      const states = await browser.execute(
        (ids) =>
          ids.map((id) => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="plugin-store-install"]'),
            ).find((candidate) => candidate.dataset.pluginId === id);
            return button ? button.disabled : null;
          }),
        names.map((name) => `${name}@${marketplace}`),
      );
      return states.every((value, index) => value === expected[index]);
    },
    { timeout: 30000, timeoutMsg: `Expected install busy states ${JSON.stringify(expected)}` },
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
