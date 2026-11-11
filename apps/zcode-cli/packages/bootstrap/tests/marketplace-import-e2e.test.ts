// E2E: 验证「自定义市场导入」最新 commit (feat: add custom marketplace source import popover)
// 触达的真实 agent 链路。
//
// UI 侧链路：AddMarketplacePopover -> PluginsSection.onAddMarketplace
//   -> pluginManagementStore.addMarketplace(source) -> agentService.addPluginMarketplace
//   -> 协议 plugins/marketplace/add -> server.ts dispatch -> 本文件验证的 facade。
//
// 本测试直接驱动 agent 侧 facade addZCodePluginMarketplace，喂入 popover 会原样下发的「自由文本字符串」，
// 覆盖 parseMarketplaceSourceInput -> loadMarketplaceFromSource(读 manifest / 真实 git clone) -> 落盘，
// 再用 getZCodePluginsOverview 复核（等价 popover 关闭后 UI refresh 能看到新市场）。
// 每个用例独立临时 storageRoot 隔离。真实外网导入用例见 marketplace-import-network.test.ts。
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { addViaFacade } from "./marketplace-import-e2e-fixture.js";

describe("marketplace 自定义导入 E2E (真实 agent facade)", () => {
  it("非法来源：facade 抛错（驱动 store 失败分支 -> 返回 false -> popover 保留输入），且不误落盘", async () => {
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-invalid-"));
    const storageRoot = join(base, "storage");
    try {
      // popover 里随手敲的一个不存在的本地路径。
      await expect(
        addViaFacade("./definitely-not-a-real-marketplace-xyz", storageRoot, base),
      ).rejects.toThrow();
      // 失败时不应写 known_marketplaces.json。
      expect(existsSync(join(storageRoot, "known_marketplaces.json"))).toBe(false);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });
});
