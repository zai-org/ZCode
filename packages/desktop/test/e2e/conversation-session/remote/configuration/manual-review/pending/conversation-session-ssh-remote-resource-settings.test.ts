import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspace,
  readDualSSHRuntimeConfig,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";
import { uploadSSHFixtureFile } from "#e2e/helpers/ssh-version-policy-fixture";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_RESOURCE_SETTINGS";
const resource = process.env.R3_RESOURCE_SETTINGS_CASE ?? "command";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-resource-settings",
);
const name = `ssh-guide-${resource}`;

async function openSection() {
  if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()))
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(
    testId(
      TID_SETTINGS_SECTION_NAV,
      resource === "command" ? "commands" : resource === "hook" ? "hooks" : resource,
    ),
  );
}
async function clickLabel(label: string) {
  await browser.waitUntil(
    () =>
      browser.execute((text) => {
        const item = Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-settings-content-frame] button"),
        ).find(
          (button) =>
            !button.disabled &&
            button.getClientRects().length &&
            (button.innerText.trim() === text ||
              button.getAttribute("aria-label") === text ||
              button.getAttribute("title") === text),
        );
        item?.click();
        return Boolean(item);
      }, label),
    { timeout: 15_000, timeoutMsg: `${MARKER}: 缺少 ${label}` },
  );
}

describe(`${MARKER}: 同名同路径设备上的设置隔离`, () => {
  const facts: Record<string, unknown> = { resource };
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "resource-settings.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it(`SSH-GUIDE-RESOURCE ${resource}: 当前机器管理不串到同路径另一台机器或本机`, async function () {
    this.timeout(20 * 60_000);
    if (!["skill", "mcp", "command", "hook"].includes(resource)) throw new Error("未知资源类型");
    const config = readDualSSHRuntimeConfig(MARKER);
    const [a, b] = config.targets;
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(artifactDir, { recursive: true });
    if (resource === "skill") {
      for (const [target, actor] of [
        [a, "A"],
        [b, "B"],
      ] as const) {
        const file = join(artifactDir, `skill-${actor}.md`);
        await writeFile(
          file,
          `---\nname: ${name}\ndescription: GUIDE_SKILL_${actor}\n---\n\nReturn GUIDE_SKILL_${actor}.\n`,
        );
        expect((await runSSHCommand(target, `mkdir -p "$HOME/.zcode/skills/${name}"`)).code).toBe(
          0,
        );
        await uploadSSHFixtureFile(
          target,
          file,
          `/home/${target.username}/.zcode/skills/${name}/SKILL.md`,
        );
      }
    }
    const tabA = await connectSSHWorkspace({
      caseMarker: MARKER,
      config: a,
      workspacePath: config.workspacePath,
    });
    const tabB = await connectSSHWorkspace({
      caseMarker: MARKER,
      config: b,
      workspacePath: config.workspacePath,
    });
    expect(parseRemoteWorkspaceIdentity(tabA.workspaceIdentity!)?.sourceServerId).not.toBe(
      parseRemoteWorkspaceIdentity(tabB.workspaceIdentity!)?.sourceServerId,
    );
    await connectSSHWorkspace({
      caseMarker: MARKER,
      config: a,
      workspacePath: config.workspacePath,
    });
    await openSection();
    expect(await $("[data-settings-machine]").isExisting()).toBe(false);
    expect(await $('[data-plugin-scope-trigger="true"]').getText()).not.toContain("本机");

    if (resource === "skill") {
      await browser.waitUntil(
        async () => (await $("[data-settings-content-frame]").getText()).includes("GUIDE_SKILL_A"),
        { timeout: 30_000 },
      );
      expect(await $("[data-settings-content-frame]").getText()).not.toContain("GUIDE_SKILL_B");
      await browser.waitUntil(
        () =>
          browser.execute((skill) => {
            const heading = Array.from(
              document.querySelectorAll<HTMLElement>(
                "[data-settings-content-frame] h3, [data-settings-content-frame] p, [data-settings-content-frame] span",
              ),
            ).find((item) => item.textContent?.trim() === skill);
            let row: Element | null | undefined = heading;
            while (row && !row.querySelector('button[aria-label="删除"]')) row = row.parentElement;
            const button = row?.querySelector<HTMLButtonElement>('button[aria-label="删除"]');
            button?.click();
            return Boolean(button);
          }, name),
        { timeout: 15_000, timeoutMsg: "当前设备技能没有删除入口" },
      );
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                '[role="dialog"] button, [role="alertdialog"] button',
              ),
            ).find((item) => /^(删除|Delete)$/iu.test(item.innerText.trim()));
            button?.click();
            return Boolean(button);
          }),
        { timeout: 15_000 },
      );
      await browser.waitUntil(
        async () =>
          (await runSSHCommand(a, `test ! -e "$HOME/.zcode/skills/${name}/SKILL.md"`)).code === 0,
      );
      expect(
        (await runSSHCommand(b, `cat "$HOME/.zcode/skills/${name}/SKILL.md"`)).stdout,
      ).toContain("GUIDE_SKILL_B");
      facts.deletedOnlyTargetSkill = true;
    } else {
      await clickLabel(
        resource === "mcp" ? "新建 MCP 服务器" : resource === "hook" ? "新建钩子" : "新建",
      );
      if (resource === "mcp") {
        const file = join(artifactDir, "mcp-server.mjs");
        await writeFile(
          file,
          'import { createInterface } from "node:readline";\ncreateInterface({ input: process.stdin }).on("line", line => { const r = JSON.parse(line); if (r.id == null) return; const result = r.method === "initialize" ? { protocolVersion: r.params.protocolVersion, serverInfo: {name:"guide",version:"1"}, capabilities:{tools:{}} } : r.method === "tools/list" ? {tools:[]} : {}; process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n"); });\n',
        );
        const remoteFile = `${config.workspacePath}/.zcode-e2e/resource-settings/mcp-server.mjs`;
        expect(
          (
            await runSSHCommand(
              a,
              `mkdir -p '${config.workspacePath}/.zcode-e2e/resource-settings'`,
            )
          ).code,
        ).toBe(0);
        await uploadSSHFixtureFile(a, file, remoteFile);
        const installed = JSON.parse(
          (await runSSHCommand(a, 'cat "$HOME/.zcode/server/current.json"')).stdout,
        );
        await $('input[placeholder="my-mcp-server"]').setValue(name);
        await $('input[placeholder="npx"]').setValue(`${installed.releaseDir}/runtime/node`);
        await $('input[placeholder="-y @modelcontextprotocol/server-memory"]').setValue(remoteFile);
      } else if (resource === "command") {
        await $('input[placeholder="my-command"]').setValue(name);
        await $("[data-settings-content-frame] textarea").setValue(`GUIDE_COMMAND_A ${name}`);
      } else {
        await $("#command").setValue(`printf '${name}'`);
      }
      await clickLabel("保存");
      let paths = "";
      const lookup = `find "$HOME/.zcode" '${config.workspacePath}/.zcode' -type f \\( -name '*.json' -o -name '*.md' \\) -exec grep -lF '${name}' {} \\; 2>/dev/null || true`;
      await browser.waitUntil(
        async () => {
          paths = (await runSSHCommand(a, lookup)).stdout.trim();
          return Boolean(paths);
        },
        { timeout: 30_000, timeoutMsg: `${MARKER}: UI 保存没有落到目标机器` },
      );
      expect((await runSSHCommand(b, lookup)).stdout.trim()).toBe("");
      facts.targetFiles = paths.split("\n");
    }
    await browser.saveScreenshot(join(artifactDir, "target-a.png"));
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await connectSSHWorkspace({
      caseMarker: MARKER,
      config: b,
      workspacePath: config.workspacePath,
    });
    await openSection();
    if (resource === "skill") {
      await browser.waitUntil(
        async () => (await $("[data-settings-content-frame]").getText()).includes("GUIDE_SKILL_B"),
        { timeout: 30_000 },
      );
    } else {
      expect(await $("[data-settings-content-frame]").getText()).not.toContain(name);
    }
    for (const relative of ["cli/config.json", `commands/${name}.md`, `cli/commands/${name}.md`]) {
      const local = await readFile(join(getE2EAppDataPaths().storageRoot, relative), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        },
      );
      expect(local).not.toContain(name);
    }
    facts.otherSourceAndLocalUnchanged = true;
  });
});
