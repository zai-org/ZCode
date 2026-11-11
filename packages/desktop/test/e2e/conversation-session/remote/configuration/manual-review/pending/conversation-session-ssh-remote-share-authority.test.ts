import { createServer } from "node:http";
import { createConnection } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "ssh2";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { runSSHCommand, waitForRemoteTab } from "#e2e/helpers/ssh-remote-p0";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { selectV4TaskById, waitForV4TimelineContaining } from "#e2e/helpers/v4-conversation";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";

const MARKER = "E2E_SSH_SHARE_AUTHORITY";
// 合成身份仅发送到本 case 的 loopback API；记录只保存 actor 标签，不保存凭据值。
const syntheticToken = (actor: string) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: actor, exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      "base64url",
    ),
    Buffer.from(`synthetic-${actor}`).toString("base64url"),
  ].join(".");
const LOCAL_TOKEN = syntheticToken("ssh-guide-local-account");
const REMOTE_TOKEN = syntheticToken("ssh-guide-remote-account");
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-share-authority",
);

describe(`${MARKER}: 远端分享账号权威与未登录拒绝`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let forwarding: Client | undefined;
  let api: ReturnType<typeof createServer> | undefined;
  const requests: Array<{ path: string; method: string; actor: string }> = [];
  const facts: Record<string, unknown> = {
    fixture: "synthetic-account-routing-real-ssh-local-api",
  };
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, "share-authority.json"),
      JSON.stringify({ ...facts, requests }, null, 2),
    );
    forwarding?.end();
    if (api) {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api!.close(() => resolve()));
    }
    await provider?.tunnel.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-GUIDE-SHARE 本机与远端身份不同，发布请求取远端；远端退出后本机不能代替", async function () {
    this.timeout(20 * 60_000);
    const prepared = await prepareSSHLifecycle(MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    // 分享入口依赖已恢复的 User 展示态；只热写 access_token 不会使匿名 Renderer 登录。
    // 在建立远端项目前播种并恢复合成本地账号，避免中途切换本地身份改变历史归属前提。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const localPath = getE2EAppDataPaths().credentialsFile;
        const local = JSON.parse(await readFile(localPath, "utf8"));
        Object.assign(local, {
          "oauth:active_provider": "zai",
          "oauth:zai:access_token": LOCAL_TOKEN,
          "oauth:zai:user_info": JSON.stringify({
            id: "ssh-guide-local-user",
            displayName: "SSH guide local",
            username: "ssh-guide-local-user",
          }),
          zcodejwttoken: LOCAL_TOKEN,
        });
        await writeFile(localPath, JSON.stringify(local), { mode: 0o600 });
      },
    });
    await waitForRendererAfterColdRestart(MARKER);
    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: MARKER,
      config: prepared.config,
      provider,
      label: "A",
      workspacePath: prepared.config.workspacePaths[0],
    });
    const sourceId = parseRemoteWorkspaceIdentity(task.identity)?.sourceServerId;
    if (!sourceId) throw new Error("缺少设备身份");
    api = createServer((request, response) => {
      const auth = request.headers.authorization;
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      requests.push({
        path,
        method: request.method ?? "GET",
        actor:
          auth === `Bearer ${REMOTE_TOKEN}`
            ? "remote"
            : auth === `Bearer ${LOCAL_TOKEN}`
              ? "local"
              : auth
                ? "other"
                : "none",
      });
      response.setHeader("content-type", "application/json");
      if (path.endsWith("/shares/capabilities")) {
        response.end(
          JSON.stringify({
            code: 0,
            msg: "",
            data: {
              schema_version: 1,
              ttl_ms: 60_000,
              access_modes: ["private", "public_readonly", "public_importable"],
              max_rows: 500,
              max_payload_bytes: 4_194_304,
              max_artifact_count: 0,
              max_artifact_bytes: 1,
              max_total_artifact_bytes: 1,
              allowed_artifacts: [],
            },
          }),
        );
      } else {
        // 只验证真实客户端的账号路由；实际云端发布与附件完整性由 share live case 独立验证。
        response.statusCode = 503;
        response.end(JSON.stringify({ code: 3001, msg: "synthetic route inspection completed" }));
      }
    });
    await new Promise<void>((resolve) => api!.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("缺少 API fixture 端口");
    forwarding = new Client();
    await new Promise<void>((resolve, reject) => {
      forwarding!.once("error", reject).once("ready", resolve).connect({
        host: prepared.config.host,
        port: prepared.config.port,
        username: "tunnel",
        password: prepared.config.password,
      });
    });
    forwarding.on("tcp connection", (_details, accept) => {
      const stream = accept();
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      stream.on("error", () => socket.destroy());
      socket.on("error", () => stream.destroy());
      socket.once("connect", () => stream.pipe(socket).pipe(stream));
    });
    const remotePort = await new Promise<number>((resolve, reject) =>
      forwarding!.forwardIn("127.0.0.1", 0, (error, port) =>
        error ? reject(error) : resolve(port),
      ),
    );
    const core = await readRemoteCoreIdentity(prepared.config, MARKER);
    await disconnectRemoteSource(sourceId, MARKER);
    // stop 是 Server 根命令，server stop 会误走旧 CLI，无法正确切换本 case 的 API 环境。
    const restarted = await runSSHCommand(
      prepared.config,
      `"$HOME/.zcode/server/bin/zcode" stop --json; kill -TERM ${core.supervisorPid}; ZCODE_BASE_URL='http://127.0.0.1:${remotePort}' "$HOME/.zcode/server/bin/zcode" serve --daemon --json`,
      { timeoutMs: 60_000 },
    );
    expect(restarted.code).toBe(0);
    await reconnectRemoteProject(task.identity, MARKER);

    await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: task.identity,
      expectedPath: task.workspacePath,
      timeoutMs: 180_000,
    });
    const setRemote = `const fs=await import('node:fs/promises');const p=process.env.HOME+'/.zcode/v2/credentials.json';const d=JSON.parse(await fs.readFile(p,'utf8'));Object.assign(d,{'oauth:active_provider':'zai','oauth:zai:access_token':${JSON.stringify(REMOTE_TOKEN)},zcodejwttoken:${JSON.stringify(REMOTE_TOKEN)}});await fs.writeFile(p,JSON.stringify(d),{mode:384});`;
    const runtime = JSON.parse(
      (await runSSHCommand(prepared.config, 'cat "$HOME/.zcode/server/current.json"')).stdout,
    );
    const set = await runSSHCommand(
      prepared.config,
      `'${runtime.releaseDir}/runtime/node' --input-type=module -e '${setRemote.replaceAll("'", "'\\''")}'`,
    );
    expect(set.code).toBe(0);
    // 原地重连只恢复项目 attachment；需真实选择原会话，草稿页没有分享入口。
    await selectV4TaskById(task.taskId);
    await waitForV4TimelineContaining(task.firstReply, 60_000);
    await clickTestIdByDom("conversation-share-trigger");
    // 分享已合并为单个设置浮窗；仍须在真实 UI 勾选披露确认再发布。
    await $('[data-testid="conversation-share-popover"]').waitForDisplayed({ timeout: 30_000 });
    await clickTestIdByDom("conversation-share-disclosure-checkbox");
    await clickTestIdByDom("conversation-share-confirm");
    await $('[data-testid="conversation-share-error-details"]').waitForDisplayed({
      timeout: 60_000,
    });
    const publications = requests.filter(
      (request) => request.method === "POST" && request.path.includes("/shares"),
    );
    expect(publications.length).toBeGreaterThan(0);
    expect(publications.every((request) => request.actor === "remote")).toBe(true);
    expect(requests.some((request) => request.actor === "local")).toBe(false);
    facts.remoteAccountSelected = true;

    const removeRemote =
      "const fs=await import('node:fs/promises');const p=process.env.HOME+'/.zcode/v2/credentials.json';const d=JSON.parse(await fs.readFile(p,'utf8'));for(const k of ['oauth:active_provider','oauth:zai:access_token','zcodejwttoken'])delete d[k];await fs.writeFile(p,JSON.stringify(d),{mode:384});";
    expect(
      (
        await runSSHCommand(
          prepared.config,
          `'${runtime.releaseDir}/runtime/node' --input-type=module -e '${removeRemote.replaceAll("'", "'\\''")}'`,
        )
      ).code,
    ).toBe(0);
    const beforeRetry = requests.filter(
      (request) => request.method === "POST" && request.path.includes("/shares"),
    ).length;
    await clickTestIdByDom("conversation-share-confirm");
    await browser.waitUntil(
      async () =>
        /登录|authentication|sign in|log in/iu.test(
          await $('[data-testid="conversation-share-error-details"]').getText(),
        ),
      { timeout: 30_000, timeoutMsg: `${MARKER}: 远端未登录没有明确拒绝` },
    );
    expect(
      requests.filter((request) => request.method === "POST" && request.path.includes("/shares"))
        .length,
    ).toBe(beforeRetry);
    facts.remoteLogoutRejectedWithoutLocalFallback = true;
    await browser.saveScreenshot(join(artifactDir, "remote-logout-refused.png"));
  });
});
