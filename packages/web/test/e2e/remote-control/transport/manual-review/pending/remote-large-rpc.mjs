// MRL01/MRL02：真实 Web 与 RPC adapter 的大消息回归；账号、relay、业务数据均为合成夹具。
// 运行：pnpm exec tsx packages/web/test/e2e/remote-control/transport/manual-review/pending/remote-large-rpc.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  WebRemoteControlRelayPayloadSerializer,
} from "@zcode/client";
import { ServiceChannels } from "@zcode/shared";
import { createDeviceSwitchDesktopBridge } from "../../../projects/manual-review/pending/remote-device-switch.helpers.mjs";
import { setup } from "../../../authentication/manual-review/pending/remote-login-v2.helpers.mjs";

const root = resolve(import.meta.dirname, "../../../../../../../..");
const { VSBuffer } = await import(pathToFileURL(resolve(root, "packages/rpc/src/index.ts")));
const artifacts = resolve(root, ".tmp/remote-large-rpc-e2e");
const MiB = 1024 * 1024;
const results = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(artifacts, { recursive: true });

function createTransportPair({ holdAck = false, available = true, replayBufferMaxBytes } = {}) {
  const peers = [];
  const faults = [];
  const delivered = [[], []];
  const frames = [[], []];
  const heldAcks = [];
  const flow = { saturated: 0, drained: 0 };
  let now = 1;
  for (let side = 0; side < 2; side++) {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const peer = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: "b".repeat(256),
      bridgeGeneration: Number.MAX_SAFE_INTEGER,
      recoveryId: "r".repeat(256),
      now: () => now,
      ...(replayBufferMaxBytes === undefined ? {} : { replayBufferMaxBytes }),
      measureFrameBytes: (frame) => serializer.prepare(frame).bytes,
      sendFrame: (frame) => {
        if (!available) return false;
        if (frame.zcode_type === "rpc-frame-ack" && holdAck) {
          heldAcks.push({ side, frame });
          return true;
        }
        const bytes = serializer.prepare(frame).bytes;
        assert.ok(bytes <= MiB, "最终物理外壳必须不超过 1 MiB");
        if (frame.zcode_type === "rpc-frame") frames[side].push(bytes);
        peers[1 - side].acceptPayload(frame);
        return true;
      },
    });
    peers.push(peer);
    peer.onDegraded((fault) => faults.push(fault.reasonCode));
    peer.protocol.onMessage((buffer) =>
      delivered[side].push({ bytes: buffer.byteLength, digest: digest(buffer.buffer) }),
    );
  }
  peers[0].onSaturated(() => flow.saturated++);
  peers[0].onDrained(() => flow.drained++);
  return {
    peers,
    faults,
    delivered,
    frames,
    flow,
    send(bytes, side = 0) {
      const buffer = new Uint8Array(bytes).fill(97);
      peers[side].protocol.send(VSBuffer.wrap(buffer));
      return { bytes, digest: digest(buffer) };
    },
    releaseAck() {
      holdAck = false;
      for (const { side, frame } of heldAcks.splice(0)) peers[1 - side].acceptPayload(frame);
    },
    resume() {
      available = true;
      peers[0].replayUnacknowledged();
    },
    advance(ms) {
      now += ms;
    },
    dispose() {
      for (const peer of peers) peer.dispose();
    },
  };
}

function transportChecks() {
  for (const [bytes, side] of [
    [6 * MiB, 0],
    [8 * MiB + 1, 0],
    [16 * MiB, 0],
    [8 * MiB, 1],
  ]) {
    const p = createTransportPair();
    try {
      const expected = p.send(bytes, side);
      assert.deepEqual(p.delivered[1 - side], [expected]);
      assert.deepEqual(p.faults, []);
      assert.equal(p.peers[side].unacknowledgedBytes, 0);
      results.push({
        case: "MRL02",
        scenario: "legal-message",
        bytes,
        side,
        fragments: p.frames[side].length,
        status: "passed",
      });
    } finally {
      p.dispose();
    }
  }
  const scenarios = [
    [
      "inflight-headroom",
      { holdAck: true },
      (p) => {
        const first = p.send(5 * MiB);
        assert.ok(p.peers[0].unacknowledgedBytes < 8 * MiB);
        const second = p.send(16 * MiB);
        assert.deepEqual(p.delivered[1], [first, second]);
        assert.deepEqual(p.faults, []);
        assert.deepEqual(p.flow, { saturated: 1, drained: 0 });
        p.releaseAck();
        assert.equal(p.peers[0].unacknowledgedBytes, 0);
        assert.deepEqual(p.flow, { saturated: 1, drained: 1 });
      },
    ],
    [
      "lost-ack-replay",
      { holdAck: true },
      (p) => {
        const expected = p.send(8 * MiB);
        const firstBatch = [...p.frames[0]];
        p.peers[0].replayUnacknowledged();
        assert.deepEqual(p.frames[0], [...firstBatch, ...firstBatch]);
        assert.deepEqual(p.delivered[1], [expected]);
        const foreignAck = {
          zcode_type: "rpc-frame-ack",
          bridgeSessionId: "foreign",
          bridgeGeneration: Number.MAX_SAFE_INTEGER,
          recoveryId: "r".repeat(256),
          ackMessageSeq: 1,
        };
        assert.equal(p.peers[0].acceptPayload(foreignAck), false);
        assert.ok(p.peers[0].unacknowledgedBytes > 0);
        p.releaseAck();
        assert.equal(p.peers[0].unacknowledgedBytes, 0);
        assert.deepEqual(p.faults, []);
      },
    ],
    [
      "temporarily-unavailable",
      { available: false },
      (p) => {
        const expected = p.send(8 * MiB);
        assert.equal(p.frames[0].length, 0);
        p.resume();
        assert.deepEqual(p.delivered[1], [expected]);
        assert.deepEqual(p.faults, []);
      },
    ],
    [
      "logical-limit",
      {},
      (p) => {
        p.send(16 * MiB + 1);
        assert.deepEqual(p.faults, ["remote.rpcFrame.messageTooLarge"]);
        assert.equal(p.frames[0].length, 0);
        assert.deepEqual(p.delivered[1], []);
      },
    ],
    [
      "lower-explicit-budget",
      { replayBufferMaxBytes: MiB },
      (p) => {
        p.send(MiB);
        assert.deepEqual(p.faults, ["remote.rpcFrame.replayBufferExceeded"]);
        assert.equal(p.frames[0].length, 0);
      },
    ],
    ...[undefined, 64 * MiB].map((replayBufferMaxBytes) => [
      replayBufferMaxBytes ? "hard-cap-clamp" : "default-cap",
      { holdAck: true, replayBufferMaxBytes },
      (p) => {
        p.send(8 * MiB);
        p.send(8 * MiB);
        assert.deepEqual(p.faults, []);
        const before = p.frames[0].length;
        p.send(8 * MiB);
        assert.deepEqual(p.faults, ["remote.rpcFrame.replayBufferExceeded"]);
        assert.equal(p.frames[0].length, before, "超限批次不得部分发送");
        assert.equal(p.delivered[1].length, 2);
        assert.equal(p.peers[0].signal.aborted, true);
      },
    ]),
    [
      "ack-deadline",
      { holdAck: true },
      (p) => {
        p.send(1024);
        p.advance(45_001);
        p.peers[0].replayUnacknowledged();
        assert.deepEqual(p.faults, ["remote.rpcFrame.replayGraceExceeded"]);
      },
    ],
  ];
  for (const [scenario, options, run] of scenarios) {
    const pair = createTransportPair(options);
    try {
      run(pair);
      results.push({ case: "MRL02", scenario, status: "passed" });
    } finally {
      pair.dispose();
    }
  }
}

async function browserScenario(browser, origin, { width, theme, locale }) {
  const h = await setup(browser, { width, theme, locale, signedIn: true });
  const { page, context } = h;
  page.setDefaultTimeout(30_000);
  const prefix = `${width}-${theme}-${locale}`;
  const traffic = {
    opens: 0,
    faults: [],
    recoveries: [],
    documentNavigations: 0,
    largeMessageSeqs: [],
    ackedMessageSeqs: [],
    errors: [],
  };
  const bridges = new Map();
  const workspacePath = "/workspace/large-rpc";
  const projectName = "E2E_MRL_PROJECT";
  let acked = false;
  await context.route(/\/api\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/") || path.startsWith("/api/v1/remote/")) return route.fallback();
    await route.fulfill({ json: { code: 0, data: {} } });
  });
  await context.addInitScript(() => {
    window.__mrlHomeMounts = 0;
    const seen = new WeakSet();
    new MutationObserver(() => {
      const home = document.querySelector('[data-mobile-page="home"]');
      if (home && !seen.has(home)) {
        seen.add(home);
        window.__mrlHomeMounts++;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) traffic.documentNavigations++;
  });
  page.on("pageerror", (error) => traffic.errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("recover terminal session"))
      traffic.recoveries.push(message.text());
  });
  await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/, (socket) => {
    const send = (payload) => socket.send(JSON.stringify({ type: "data", payload }));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "auth_init")
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "e2e-device", pair_status: "matched" }),
        );
      if (message.type === "pair_status_query")
        socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
      const p = message.payload;
      if (!p) return;
      if (p.zcode_type === "rpc-frame" || p.zcode_type === "rpc-frame-ack") {
        bridges.get(p.bridgeSessionId)?.acceptPayload(p);
        if (p.zcode_type === "rpc-frame-ack") {
          traffic.ackedMessageSeqs.push(p.ackMessageSeq);
          acked ||= traffic.largeMessageSeqs.some((seq) => p.ackMessageSeq >= seq);
        }
        return;
      }
      const workspaces = [{ workspacePath, kind: "local", label: "E2E_MRL" }];
      const result = {
        windowControlSessionId: "e2e-device",
        desktopAppVersion: "3.16.3",
        workspaces,
        initialViewState: { activeWorkspaceKey: workspacePath, updatedAt: 1 },
      };
      if (p.zcode_type === "bootstrap-request" || p.zcode_type === "workspace-list-request")
        send({
          zcode_type: p.zcode_type.replace("request", "response"),
          requestId: p.requestId,
          success: true,
          result,
        });
      if (p.zcode_type === "mobile-view-state-update")
        send({ zcode_type: "mobile-view-state-updated", requestId: p.requestId });
      if (p.zcode_type !== "workspace-bridge-open") return;
      traffic.opens++;
      for (const bridge of bridges.values()) bridge.dispose();
      bridges.clear();
      const bridge = {
        ...workspaces[0],
        workspaceKey: workspacePath,
        bridgeSessionId: p.bridgeSessionId,
        bridgeGeneration: p.bridgeGeneration,
      };
      send({
        zcode_type: "workspace-bridge-ready",
        requestId: p.requestId,
        bridgeSessionId: p.bridgeSessionId,
        bridgeGeneration: p.bridgeGeneration,
        bridge,
      });
      const desktop = createDeviceSwitchDesktopBridge(
        {
          send(rawFrame) {
            const frame = JSON.parse(rawFrame).payload;
            if (
              frame.zcode_type === "rpc-frame" &&
              frame.messageBytes > 8 * MiB &&
              frame.fragmentIndex === 0
            )
              traffic.largeMessageSeqs.push(frame.messageSeq);
            socket.send(rawFrame);
          },
        },
        bridge,
        {
          locale,
          theme,
          responses: {
            [`${ServiceChannels.SettingsSync}:getFirstRunPromptState`]: { handled: true },
            [`${ServiceChannels.Project}:readTree`]: {
              projects: [
                {
                  id: "MRL_PROJECT",
                  hostId: "local",
                  name: projectName,
                  roots: [{ rootPath: workspacePath, position: 0, isPrimary: true }],
                  pinned: false,
                  deleted: false,
                  position: 0,
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
              tasks: [],
              // 合成原因：固定传输字节量，不依赖用户历史，也不让 UI 渲染大段正文。
              syntheticPadding: "x".repeat(8 * MiB),
            },
          },
        },
      );
      desktop.onDegraded((fault) => {
        traffic.faults.push(fault.reasonCode);
        send({
          zcode_type: "bridge-degraded",
          bridgeSessionId: p.bridgeSessionId,
          bridgeGeneration: p.bridgeGeneration,
          reason: "rpc-transport-fault",
        });
      });
      bridges.set(p.bridgeSessionId, desktop);
    });
  });
  try {
    await page.goto(
      new URL("/remote/v4?app_version=3.16.3&sid=e2e-device&mid=e2e-mid", origin).href,
      { waitUntil: "domcontentloaded", timeout: 120_000 },
    );
    // 等待数据完成或真实 fault，不用固定时长掩盖重建循环。
    const deadline = Date.now() + 30_000;
    while (!acked && traffic.faults.length === 0 && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(traffic.faults, [], "合法 8 MiB 响应不能触发 bridge 恢复");
    assert.ok(acked, "大响应必须被对端完整交付并确认");
    await page.locator(`[data-project-name="${projectName}"]`).waitFor();
    assert.equal(traffic.opens, 1);
    assert.deepEqual(traffic.recoveries, []);
    assert.equal(traffic.documentNavigations, 1);
    assert.deepEqual(traffic.errors, []);
    if (width < 768) {
      traffic.homeMounts = await page.evaluate(() => window.__mrlHomeMounts);
      assert.equal(traffic.homeMounts, 1);
    }
    await page.screenshot({ path: resolve(artifacts, `${prefix}.png`), fullPage: true });
    results.push({ case: "MRL01", width, theme, locale, status: "passed", ...traffic });
  } finally {
    await writeFile(resolve(artifacts, `${prefix}-traffic.json`), JSON.stringify(traffic, null, 2));
    await context.close();
    for (const bridge of bridges.values()) bridge.dispose();
  }
}

const vite = await createServer({
  root: resolve(root, "packages/web"),
  configFile: resolve(root, "packages/web/vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: { include: ["@pierre/diffs/worker/worker.js"] },
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const scenario of [
    { width: 390, theme: "zai-light", locale: "zh-CN" },
    { width: 1440, theme: "zai-dark", locale: "en-US" },
  ])
    await browserScenario(browser, vite.resolvedUrls.local[0], scenario);
  transportChecks();
  console.log(JSON.stringify({ status: "passed", results }, null, 2));
} finally {
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  await browser?.close();
  await vite.close();
}
