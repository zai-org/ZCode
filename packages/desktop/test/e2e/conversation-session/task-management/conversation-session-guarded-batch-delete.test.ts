// DCA-V1-19/20/23/24：仅覆盖 POSIX/Git Bash 桌面拒绝，Windows 原生语义另有 oracle。
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import {
  clickV4Stop,
  denyV4PermissionWithFeedback,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE = "conversation-session-guarded-batch-delete";
const ROOT = resolveE2ERuntimePath(CASE);
const MARKERS = [
  "E2E_GUARDED_DELETE_RECURSIVE",
  "E2E_GUARDED_DELETE_BATCH",
  "E2E_GUARDED_DELETE_GLOB",
  "E2E_GUARDED_DELETE_FIND",
  "E2E_GUARDED_DELETE_CLEAN",
] as const;
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("Autonomous batch deletion approval (pending human review)", () => {
  let originalRules = "";
  before(async () => {
    await mkdir(ROOT, { recursive: true });
    await skipOccupationOnboardingIfPresent();
  });
  beforeEach(async () => {
    originalRules = await readProjectRules();
  });
  afterEach(async () => {
    expect(await readProjectRules()).toBe(originalRules);
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(ROOT, { recursive: true, force: true });
  });
  for (const marker of MARKERS) {
    it(`${marker} refuses the new deletion match and returns the real denial`, async () => {
      const directory = join(ROOT, marker);
      await mkdir(join(directory, "target"), { recursive: true });
      for (const name of ["one.txt", "two.txt"]) {
        await writeFile(join(directory, name), "preserved");
        await writeFile(join(directory, "target", name), "preserved");
      }
      // clean 必须使用独立仓库，即使匹配回归也不能清理真实工作区。
      await promisify(execFile)("git", ["init", "-q", directory]);
      await prepareV4ConversationE2E();
      await switchV4Mode("guarded");
      await sendV4Prompt(`${marker} Execute the fixture command once.`);
      await waitForV4PermissionDialogInComposerDock();
      expect(await $('[data-permission-option-kind="allowAlways"]').isExisting()).toBe(false);
      expect(await exists(join(directory, "executed"))).toBe(false);
      expect(await denyV4PermissionWithFeedback("Preserve batch deletion fixture")).toBe(true);
      await waitForV4TimelineContaining(`${marker}_DONE`, 60000);
      const result = await getLatestUpstreamToolResultByToolCallId(`toolu_${marker}`);
      expect(result?.isError).toBe(true);
      expect(result?.content).toContain("Preserve batch deletion fixture");
      expect(await exists(join(directory, "executed"))).toBe(false);
      for (const name of ["one.txt", "two.txt", "target/one.txt", "target/two.txt"])
        expect(await readFile(join(directory, name), "utf8")).toBe("preserved");
      await $('[data-permission-option-kind="deny"]').waitForExist({ reverse: true });
    });
  }
});

async function readProjectRules(): Promise<string> {
  const path = join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite");
  if (!(await exists(path))) return "[]";
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify(
      database
        .prepare(
          "select scope, scope_id, value from local_setting where namespace = 'permission' and key = 'ruleset' order by scope, scope_id",
        )
        .all(),
    );
  } finally {
    database.close();
  }
}
