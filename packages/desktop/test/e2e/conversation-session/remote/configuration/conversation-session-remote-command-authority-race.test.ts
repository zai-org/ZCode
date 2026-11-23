import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import { clickOpenScopeMenuOption } from "#e2e/helpers/settings-scope-menu";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const run = promisify(execFile);
const MARKER = "E2E_COMMAND_AUTHORITY_RACE";
const COMMAND_DIR = "/home/dev/.zcode/commands";
const FIFO = `${COMMAND_DIR}/pending-a.md`;
const FIFO_KEEPER = "/home/dev/.zcode/e2e-command-fifo.pid";
const CONFIG = "/home/dev/.zcode/cli/config.json";
const A_MARKER = "AUTHORITY_A_ONLY";
const B_MARKER = "AUTHORITY_B_ONLY";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "command-authority-race");

async function selectUserScope(sourceId: string): Promise<void> {
  const key = `source-user:${sourceId}`;
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        if (document.querySelector('[role="menuitemradio"]')) return true;
        const trigger = [
          ...document.querySelectorAll<HTMLElement>('[data-plugin-scope-trigger="true"]'),
        ].find((element) => element.getClientRects().length > 0);
        trigger?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
        );
        return false;
      }),
    { timeout: 15_000 },
  );
  await clickOpenScopeMenuOption(key);
  await browser.waitUntil(
    () =>
      browser.execute(
        (expected) =>
          [...document.querySelectorAll<HTMLElement>('[data-plugin-scope-trigger="true"]')].some(
            (element) =>
              element.getClientRects().length > 0 && element.dataset.pluginScopeKey === expected,
          ),
        key,
      ),
    {
      timeout: 15_000,
      timeoutMsg: `Scope 没有切换到 ${key}`,
    },
  );
}

async function readConfig(container: string): Promise<string> {
  return (
    await execInRemoteContainer(container, [
      "sh",
      "-c",
      'if [ -f "$1" ]; then cat "$1"; else printf "{}"; fi',
      "sh",
      CONFIG,
    ])
  ).stdout;
}

async function fifoHasReader(container: string): Promise<boolean> {
  const result = await execInRemoteContainer(container, [
    "sh",
    "-c",
    'pid=$(sed -nE \'s/.*"pid": *([0-9]+).*/\\1/p\' "$HOME/.zcode/server/run/status.json" | head -n1); for file in /proc/"$pid"/fd/*; do if [ "$(readlink "$file" 2>/dev/null)" = "$1" ]; then printf yes; break; fi; done',
    "sh",
    FIFO,
  ]);
  return result.stdout.trim() === "yes";
}

async function startFifoKeeper(container: string): Promise<void> {
  const release = JSON.parse(
    (await execInRemoteContainer(container, ["cat", "/home/dev/.zcode/server/current.json"]))
      .stdout,
  );
  // 保留写端使 Core 的 open 能完成而 read 继续等待；因此可从 Core fd 证明请求确实在途。
  const script =
    'const fs=require("node:fs/promises"),{constants}=require("node:fs");(async()=>{const file=await fs.open(process.argv[1],constants.O_RDWR|constants.O_NONBLOCK);const timer=setInterval(()=>{},1000);process.once("SIGUSR1",()=>{void(async()=>{await file.write("---\\ndescription: AUTHORITY_A_PENDING\\n---\\nA command\\n");await file.close();const temporary=process.argv[1]+".released";await fs.writeFile(temporary,"---\\ndescription: AUTHORITY_A_PENDING\\n---\\nA command\\n");await fs.rename(temporary,process.argv[1]);await fs.rm(process.argv[2],{force:true});clearInterval(timer);})().catch(error=>{console.error(error);process.exit(1);});});await fs.writeFile(process.argv[2],String(process.pid));})().catch(error=>{console.error(error);process.exit(1);});';
  await run("docker", [
    "exec",
    "--detach",
    "--user",
    "dev",
    container,
    `${release.releaseDir}/runtime/node`,
    "-e",
    script,
    FIFO,
    FIFO_KEEPER,
  ]);
  await browser.waitUntil(
    async () =>
      (
        await execInRemoteContainer(container, [
          "sh",
          "-c",
          'test -s "$1" && printf ready',
          "sh",
          FIFO_KEEPER,
        ]).catch(() => ({ stdout: "" }))
      ).stdout === "ready",
    { timeout: 15_000 },
  );
}

async function releaseFifo(container: string): Promise<void> {
  await execInRemoteContainer(container, [
    "sh",
    "-c",
    'if [ -s "$1" ]; then kill -USR1 "$(cat "$1")"; fi',
    "sh",
    FIFO_KEEPER,
  ]);
}

describe("DSYNC-15-06：两个相同 home 远端的命令读取与写入隔离", () => {
  let secondContainer: string | undefined;
  let firstContainer: string | undefined;
  const facts: Record<string, unknown> = {};

  after(async () => {
    if (firstContainer) await releaseFifo(firstContainer).catch(() => undefined);
    if (secondContainer) await run("docker", ["rm", "-f", secondContainer]);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "facts.json"), JSON.stringify(facts, null, 2));
    await clearAppData();
  });

  it("A 读取挂起时 B 独立加载，A 迟到不覆盖 B，B 的开关只写 B", async function () {
    this.timeout(15 * 60_000);
    firstContainer = readRemoteDockerContainer(MARKER);
    const configA = readSSHRuntimeConfig(MARKER);
    secondContainer = `zcode-command-authority-${randomBytes(6).toString("hex")}`;
    facts.fixtureContainers = { first: firstContainer, second: secondContainer };
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "facts.json"), JSON.stringify(facts, null, 2));
    await run("docker", [
      "run",
      "-d",
      "--name",
      secondContainer,
      "--label",
      "zcode.e2e.run=r3-server",
      "--label",
      "zcode.e2e.runner=local-docker",
      "-p",
      "127.0.0.1::22",
      "zcode-remote-ssh:test",
    ]);
    // 两个临时目标共用 runner 生成的口令，确保其现有日志脱敏覆盖第二条真实 SSH 线路。
    const password = configA.password;
    await execInRemoteContainer(secondContainer, ["chpasswd"], {
      user: "0",
      input: `dev:${password}\n`,
    });
    await execInRemoteContainer(secondContainer, ["mkdir", "-p", configA.workspacePaths[0]]);
    const port = Number(
      (await run("docker", ["port", secondContainer, "22"])).stdout.trim().split(":").at(-1),
    );
    const configB = { host: "127.0.0.1", port, username: "dev", password };
    await browser.waitUntil(
      async () => {
        try {
          return (await runSSHCommand(configB, "true")).code === 0;
        } catch {
          return false;
        }
      },
      { timeout: 30_000, timeoutMsg: "第二个 SSH fixture 未就绪" },
    );
    await prepareV4ConversationE2E({ skipProvider: true });
    const a = await connectSSHWorkspace({
      caseMarker: MARKER,
      config: configA,
      workspacePath: configA.workspacePaths[0],
    });
    const b = await connectSSHWorkspace({
      caseMarker: MARKER,
      config: configB,
      workspacePath: configA.workspacePaths[0],
    });
    const sourceA = parseRemoteWorkspaceIdentity(a.workspaceIdentity!)?.sourceServerId;
    const sourceB = parseRemoteWorkspaceIdentity(b.workspaceIdentity!)?.sourceServerId;
    expect(sourceA).toBeTruthy();
    expect(sourceB).toBeTruthy();
    expect(sourceA).not.toBe(sourceB);
    facts.sources = { sourceA, sourceB, home: "/home/dev" };
    await writeRemoteContainerFile(
      firstContainer,
      `${COMMAND_DIR}/authority-a.md`,
      `---\ndescription: ${A_MARKER}\n---\nA only\n`,
    );
    await writeRemoteContainerFile(
      secondContainer,
      `${COMMAND_DIR}/authority-b.md`,
      `---\ndescription: ${B_MARKER}\n---\nB only\n`,
    );
    await execInRemoteContainer(firstContainer, ["mkfifo", FIFO]);
    await startFifoKeeper(firstContainer);
    const beforeA = await readConfig(firstContainer);
    const beforeB = await readConfig(secondContainer);
    // 从本机 Scope 进入，避免先加载 B 后由缓存掩盖同 home 的在途请求串用。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await waitForTestIdByDom(TID_SETTINGS_PAGE);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "commands"));
    await selectUserScope(sourceA!);
    await browser.waitUntil(() => fifoHasReader(firstContainer!), {
      timeout: 30_000,
      timeoutMsg: "A 的命令读取未进入真实 FIFO 阻塞点",
    });
    facts.aReadBlocked = true;
    await selectUserScope(sourceB!);
    await browser.waitUntil(
      async () => (await browser.execute(() => document.body.innerText)).includes(B_MARKER),
      {
        timeout: 30_000,
        timeoutMsg: "B 的用户命令未显示，需核对独立读取结果与 Scope 过滤",
      },
    );
    expect(await browser.execute(() => document.body.innerText)).not.toContain(A_MARKER);
    await browser.saveScreenshot(resolve(artifactDir, "b-loaded-while-a-blocked.png"));
    await releaseFifo(firstContainer);
    await browser.waitUntil(async () => !(await fifoHasReader(firstContainer!)), {
      timeout: 15_000,
    });
    expect(await browser.execute(() => document.body.innerText)).toContain(B_MARKER);
    expect(await browser.execute(() => document.body.innerText)).not.toContain(A_MARKER);
    const row = $(`//p[normalize-space(text())="${B_MARKER}"]/ancestor::div[@role="button"][1]`);
    const toggle = row.$('[role="switch"]');
    await toggle.waitForClickable();
    await toggle.click();
    await browser.waitUntil(async () => (await toggle.getAttribute("aria-checked")) === "false", {
      timeout: 15_000,
    });
    await browser.waitUntil(async () => (await readConfig(secondContainer!)) !== beforeB, {
      timeout: 15_000,
    });
    expect(await readConfig(firstContainer)).toBe(beforeA);
    expect(await browser.execute(() => document.body.innerText)).toContain(B_MARKER);
    expect(await browser.execute(() => document.body.innerText)).not.toContain(A_MARKER);
    facts.onlyBChanged = true;
    await browser.saveScreenshot(resolve(artifactDir, "b-toggle-isolated.png"));
    const validConfigB = await readConfig(secondContainer);
    const corruptConfigB = '{"incomplete":';
    await writeRemoteContainerFile(secondContainer, CONFIG, corruptConfigB);
    try {
      await toggle.click();
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => document.body.innerText)).includes("not valid JSON"),
        {
          timeout: 15_000,
          timeoutMsg: "损坏配置写入未明确报错",
        },
      );
      expect(await readConfig(secondContainer)).toBe(corruptConfigB);
      expect(await readConfig(firstContainer)).toBe(beforeA);
      facts.corruptConfigPreserved = true;
      await browser.saveScreenshot(resolve(artifactDir, "corrupt-config-write-rejected.png"));
    } finally {
      await writeRemoteContainerFile(secondContainer, CONFIG, validConfigB);
    }
  });
});
