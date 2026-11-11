import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  PLUGIN_LIFECYCLE_ID,
  addLifecycleMarketplaceThroughUi,
  clickPluginControl,
  createPluginLifecycleFixture,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

describe("PLM-TEL-001 plugin lifecycle telemetry", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("reports one installation outcome after the real UI action without private data", async function () {
    this.timeout(180000);
    requirePluginManualReview();
    const fixture = await createPluginLifecycleFixture("1.0.0");
    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    const transport = await browser.electron.mock("net", "fetch");
    await transport.mockResolvedValue({ ok: true, status: 204 });
    const reports = async () => {
      await transport.update();
      return transport.mock.calls.flatMap((call) => {
        if (!String(call[0]).includes("/event/report")) return [];
        const body = (call[1] as { body?: string })?.body;
        if (!body) return [];
        const event = JSON.parse(body);
        return event.element_name === "plugin_lifecycle" &&
          event.event_extra_detail?.action === "install"
          ? [event]
          : [];
      });
    };
    expect(await reports()).toEqual([]);
    await clickPluginControl("plugin-store-install", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitUntilPluginOverview(
      (overview) => overview.installedPlugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
      "plugin did not install",
      90000,
    );
    await browser.waitUntil(async () => (await reports()).length === 1, {
      timeout: 15000,
      timeoutMsg: "missing plugin installation telemetry",
    });
    const [event] = await reports();
    expect(event.event_id).toBeTruthy();
    expect(event.event_extra_detail).toMatchObject({
      action: "install",
      result: "success",
      plugin_id: PLUGIN_LIFECYCLE_ID,
      entry: "store_detail",
      client_kind: "desktop",
    });
    expect(Number(event.event_extra_detail.duration_ms)).toBeGreaterThanOrEqual(0);
    expect(event.event_extra_detail).not.toHaveProperty("operation_id");
    expect(JSON.stringify(event.event_extra_detail)).not.toContain("/Users/");
    expect(JSON.stringify(event.event_extra_detail)).not.toContain("workspacePath");
  });
});
