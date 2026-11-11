import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function registerSessionSelectionCases({
  getBrowser,
  getOrigin,
  artifacts,
  trackProjectRenders,
}) {
  for (const mobile of [false, true])
    for (const theme of ["light", "dark"])
      test(
        `SPT08 session selection ${mobile ? "mobile" : "desktop"}/${theme}`,
        { timeout: 60000 },
        async () => {
          const page = await getBrowser().newPage({
            viewport: { width: mobile ? 430 : 1200, height: 800 },
          });
          const evidence = [];
          const errors = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          page.setDefaultTimeout(10000);
          page.setDefaultNavigationTimeout(45000);
          await page.addInitScript(trackProjectRenders);
          await page.addInitScript(() =>
            localStorage.setItem(
              "zcode-project-sidebar-preferences",
              JSON.stringify({
                order: [],
                view: "projects",
                expanded: { '["local","p0"]': true, '["local","p1"]': true },
              }),
            ),
          );
          const settle = () =>
            page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
          const counts = () =>
            page.evaluate(() => ({
              projects: { ...window.__projectRendersById },
              rows: { ...window.__taskRowRenders },
            }));
          const changes = (before, after) =>
            Object.keys(after)
              .filter((key) => after[key] !== before[key])
              .sort();
          try {
            await page.goto(
              `${getOrigin()}fixture?sessionSwitch=1&theme=${theme}&mobile=${mobile ? 1 : 0}`,
            );
            const project = page.locator('[data-project-id="p0"]');
            const row = (id) => project.getByTestId(`task-item-${id}`);
            await row("switch-0").waitFor();
            await settle();
            await page.evaluate(() => {
              window.__selectionNodes = [
                ...document.querySelectorAll("[data-project-id], [data-task-item-key]"),
              ];
            });
            let before = await counts();
            for (const [id, expected] of [
              ["switch-0", ["/example:switch-0"]],
              ["switch-1", ["/example:switch-0", "/example:switch-1"]],
              ["switch-0", ["/example:switch-0", "/example:switch-1"]],
            ]) {
              await row(id).click();
              await page.getByTestId("current-task").filter({ hasText: id }).waitFor();
              await settle();
              const after = await counts();
              const sample = {
                id,
                projects: changes(before.projects, after.projects),
                rows: changes(before.rows, after.rows),
                expected,
              };
              evidence.push(sample);
              before = after;
              assert.match(await row(id).getAttribute("class"), /bg-selected/);
              assert.doesNotMatch(
                await page
                  .locator('[data-project-id="p1"]')
                  .getByTestId("task-item-switch-0")
                  .getAttribute("class"),
                /bg-selected/,
              );
            }
            // 新建走真实 Root 导航：只能取消原行选中，不能把清空 activeTaskId 传播给整列。
            await page.getByTestId("task-new-button").click();
            await page.getByTestId("current-task").filter({ hasText: "draft" }).waitFor();
            await settle();
            const afterDraft = await counts();
            evidence.push({
              id: "new-draft",
              projects: changes(before.projects, afterDraft.projects),
              rows: changes(before.rows, afterDraft.rows),
              expected: ["/example:switch-0"],
            });
            assert.doesNotMatch(await row("switch-0").getAttribute("class"), /bg-selected/);
            assert.equal(
              await page.evaluate(() => window.__selectionNodes.every((node) => node.isConnected)),
              true,
            );
            await project.getByTestId("virtual-project-files").click();
            await page.waitForFunction(() => window.__openedFiles?.fileRevision === 0);
            await page.getByTestId("replace-file-handler").click();
            await project.getByTestId("virtual-project-files").click();
            await page.waitForFunction(() => window.__openedFiles?.fileRevision === 1);
            assert.equal(
              await page.evaluate(() => window.__openedFiles.target.workspacePath),
              "/example",
            );
            await page.screenshot({
              path: join(artifacts, `session-selection-${mobile}-${theme}.png`),
            });
            assert.deepEqual(errors, []);
            for (const sample of evidence) {
              assert.deepEqual(sample.projects, [], `${sample.id}: unrelated projects rendered`);
              assert.deepEqual(
                sample.rows,
                sample.expected,
                `${sample.id}: unrelated task rows rendered`,
              );
            }
          } finally {
            await writeFile(
              join(artifacts, `session-selection-${mobile}-${theme}.json`),
              JSON.stringify({ mobile, theme, evidence, errors }, null, 2),
            );
            await page.close();
          }
        },
      );
}
