import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

export function registerActivityHistoryCases({ getBrowser, getOrigin, artifacts }) {
  for (const width of [390, 1200]) {
    for (const theme of ["light", "dark"]) {
      test(`unknown total preserves observed result states ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          for (const [mix, label, secondary] of [
            ["resultPending,cancelled", "Completed", null],
            ["cancelled", "Activity", "Stopped"],
            ["failed,resultPending,cancelled", "Failed", "1"],
          ]) {
            await page.goto(
              getOrigin() +
                `fixture?real=1&endedOnly=1&theme=${theme}&locale=en-US&completedTotal=unknown&resultMix=${mix}`,
            );
            const capsule = page.locator('[data-status-capsule="activity"]');
            await capsule.waitFor();
            assert.equal(await capsule.locator("[data-capsule-label]").textContent(), label);
            const count = capsule.locator("[data-status-capsule-secondary]");
            if (secondary === null) assert.equal(await count.count(), 0);
            else assert.equal(await count.textContent(), secondary);
          }
        } finally {
          await page.close();
        }
      });
      test(`unknown completed count is not a preview total ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          await page.goto(
            getOrigin() +
              `fixture?real=1&endedOnly=1&theme=${theme}&locale=en-US&completedTotal=unknown`,
          );
          const capsule = page.locator('[data-status-capsule="activity"]');
          await capsule.waitFor();
          assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Completed");
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").count(), 0);
          await capsule.click();
          assert.ok((await page.locator("[data-activity-id]").count()) > 0);
        } finally {
          await page.close();
        }
      });
      test(`complete history count exceeds preview ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          for (const total of [9, 105, 114]) {
            await page.goto(
              getOrigin() +
                `fixture?real=1&endedOnly=1&theme=${theme}&locale=en-US&completedTotal=${total}`,
            );
            const capsule = page.locator('[data-status-capsule="activity"]');
            await capsule.waitFor();
            assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Completed");
            assert.equal(
              await capsule.locator("[data-status-capsule-secondary]").innerText(),
              String(total),
            );
            // 总数大于预览；不靠扩充头像/明细来凑出总数。
            assert.equal(await capsule.locator("[data-subagent-avatar]").count(), 1);
          }
        } finally {
          await page.close();
        }
      });
      test(`ended activity hides duplicate descriptions ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          for (const summary of [
            "Inspect files",
            "  Inspect files  ",
            "   ",
            "Inspection complete",
          ]) {
            await page.goto(
              getOrigin() +
                `fixture?real=1&endedOnly=1&theme=${theme}&locale=en-US&agentSummary=${encodeURIComponent(summary)}`,
            );
            await page.locator('[data-status-capsule="activity"]').click();
            const row = page.locator('[data-activity-result="completed"]');
            const description = row.locator("span.line-clamp-2.text-ui-sm");
            assert.equal(await description.count(), summary === "Inspection complete" ? 1 : 0);
            assert.equal(await row.getByText("Inspect files", { exact: true }).count(), 1);
            assert.match(await row.innerText(), /Completed/);
            if (summary === "Inspection complete")
              assert.equal(await description.innerText(), summary);
            if (summary === "Inspect files")
              await page.screenshot({
                path: join(artifacts, `activity-description-${width}-${theme}.png`),
              });
          }
        } finally {
          await page.close();
        }
      });
    }
  }

  for (const width of [390, 1200]) {
    for (const theme of ["light", "dark"]) {
      test(`completed actors survive parent stop and running avatars outrank waiting ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          const capsule = page.locator('[data-status-capsule="activity"]');
          for (const runStatus of ["stopped", "errored"]) {
            await page.goto(
              getOrigin() +
                `fixture?real=1&endedOnly=1&workflow=1&mixedActors=1&allActorsDone=1&actorParentEnd=1&runStatus=${runStatus}&theme=${theme}&locale=en-US`,
            );
            await capsule.waitFor();
            assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Active");
            assert.equal(await capsule.locator('[data-agent-result-badge="completed"]').count(), 3);
            await page.getByTestId("settle-workflow").click();
            assert.equal(
              await capsule.locator("[data-capsule-label]").textContent(),
              runStatus === "stopped" ? "Activity" : "Failed",
            );
            assert.equal(
              await capsule.locator("[data-status-capsule-secondary]").textContent(),
              runStatus === "stopped" ? "Stopped" : "1",
            );
            assert.equal(
              await capsule
                .locator('[data-subagent-avatar] [data-agent-result-badge="completed"]')
                .count(),
              3,
            );
            await page.screenshot({
              path: join(artifacts, `completed-actors-${runStatus}-${width}-${theme}.png`),
            });
            await page.getByTestId("dismiss-activity").click();
            assert.equal(await capsule.locator("[data-subagent-avatar]").count(), 0);
          }
          await page.goto(
            getOrigin() +
              `fixture?real=1&workflow=1&waitingActors=1&mixedAgents=1&theme=${theme}&locale=en-US`,
          );
          await capsule.waitFor();
          assert.equal(await capsule.locator("[data-subagent-avatar]").count(), 3);
          assert.equal(
            await capsule.locator('[data-subagent-avatar][data-face-state="scanning"]').count(),
            1,
          );
          assert.equal(
            await capsule.locator('[data-subagent-avatar][data-face-state="waiting"]').count(),
            2,
          );
          await page.screenshot({
            path: join(artifacts, `running-before-waiting-${width}-${theme}.png`),
          });
        } finally {
          await page.close();
        }
      });
      test(`capsule keeps running and completed avatars with configured identity ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          const capsule = page.locator('[data-status-capsule="activity"]');
          await page.goto(
            getOrigin() +
              `fixture?theme=${theme}&locale=en-US&real=1&endedOnly=1&mixedAgents=1&configuredColor=1`,
          );
          await capsule.waitFor();
          assert.equal(await capsule.locator("[data-subagent-avatar]").count(), 2);
          assert.equal(await capsule.locator('[data-agent-result-badge="completed"]').count(), 1);
          assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Active");
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
          assert.equal(
            await capsule.locator("[data-subagent-avatar]").last().getAttribute("data-face-state"),
            "scanning",
          );
          assert.equal(
            await capsule.locator("[data-subagent-avatar]").first().getAttribute("data-face-state"),
            "content",
          );
          const faceColor = () =>
            capsule
              .locator("[data-subagent-avatar]")
              .first()
              .evaluate((el) => getComputedStyle(el).getPropertyValue("--wf-face-body").trim());
          assert.equal(await faceColor(), "#3C82F6");
          assert.equal(
            await page
              .locator('[data-testid="message-agent"] [data-subagent-avatar]')
              .evaluate((el) => getComputedStyle(el).getPropertyValue("--wf-face-body").trim()),
            await faceColor(),
          );
          await capsule.click();
          const detail = page.locator(
            '[data-testid="v4-running-subagent-item"] [data-subagent-avatar]',
          );
          assert.equal(
            await detail.evaluate((el) =>
              getComputedStyle(el).getPropertyValue("--wf-face-body").trim(),
            ),
            await faceColor(),
          );
          await page.getByTestId("outside").click();
          await page.screenshot({
            path: join(artifacts, `activity-avatar-identity-${width}-${theme}.png`),
          });
          await page.goto(
            getOrigin() +
              `fixture?theme=${theme}&locale=en-US&real=1&endedOnly=1&mixedAgents=1&workflow=1&mixedActors=1&allActorsDone=1`,
          );
          await capsule.waitFor();
          assert.equal(await capsule.locator("[data-subagent-avatar]").count(), 3);
          assert.equal(
            await capsule.locator("[data-subagent-avatar]").last().getAttribute("data-face-state"),
            "scanning",
          );
          assert.equal(await capsule.locator('[data-agent-result-badge="completed"]').count(), 2);
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
          for (const runningCount of [2, 3, 4]) {
            await page.goto(
              getOrigin() +
                `fixture?theme=${theme}&locale=en-US&real=1&endedOnly=1&mixedAgents=1&runningCount=${runningCount}`,
            );
            await capsule.waitFor();
            assert.equal(await capsule.locator("[data-subagent-avatar]").count(), 3);
            assert.equal(
              await capsule.locator("[data-agent-result-badge]").count(),
              runningCount === 2 ? 1 : 0,
            );
            assert.deepEqual(
              await capsule
                .locator("[data-subagent-avatar]")
                .evaluateAll((els) => els.map((el) => el.getAttribute("data-face-state"))),
              runningCount === 2
                ? ["content", "scanning", "scanning"]
                : ["scanning", "scanning", "scanning"],
            );
            assert.equal(
              await capsule.locator("[data-status-capsule-secondary]").innerText(),
              String(runningCount),
            );
          }
          for (const status of ["success", "failed"]) {
            await page.goto(
              getOrigin() +
                `fixture?theme=${theme}&locale=en-US&real=1&endedOnly=1&agentStatus=${status}&configuredColor=1`,
            );
            await capsule.waitFor();
            assert.equal(await capsule.locator("[data-subagent-avatar]").count(), 1);
            assert.equal(await faceColor(), "#3C82F6");
            assert.equal(
              await capsule
                .locator("[data-agent-result-badge]")
                .getAttribute("data-agent-result-badge"),
              status === "success" ? "completed" : "failed",
            );
          }
        } finally {
          await page.close();
        }
      });
    }
  }

  for (const width of [390, 1200]) {
    for (const theme of ["light", "dark"]) {
      test(`workflow completion survives while bash clears on next input ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          await page.goto(
            getOrigin() + `fixture?theme=${theme}&locale=en-US&real=1&workflow=1&endedOnly=1`,
          );
          const capsule = page.locator('[data-status-capsule="activity"]');
          await capsule.waitFor();
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "2");
          await page.getByTestId("dismiss-activity").click();
          assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Completed");
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
          await capsule.click();
          assert.equal(await page.locator("[data-activity-result]").count(), 0);
          await page.getByTestId("outside").click();
          await page.screenshot({
            path: join(artifacts, `activity-completed-retained-${width}-${theme}.png`),
          });
        } finally {
          await page.close();
        }
      });
    }
  }

  for (const width of [390, 1200]) {
    for (const theme of ["light", "dark"]) {
      test(`activity failure count resets on accepted input ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          await page.goto(
            getOrigin() + `fixture?theme=${theme}&locale=en-US&real=1&agentStatus=failed`,
          );
          const capsule = page.locator('[data-status-capsule="activity"]');
          await capsule.waitFor();
          assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Active");
          await page.getByTestId("end-activity").click();
          assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Failed");
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
          await page.screenshot({ path: join(artifacts, `activity-failed-${width}-${theme}.png`) });
          await page.getByTestId("start-terminal").click();
          assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Active");
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
          await page.getByTestId("new-terminal").click();
          assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Failed");
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
          await page.getByTestId("dismiss-activity").click();
          assert.equal(await capsule.locator("[data-capsule-label]").textContent(), "Completed");
          assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
          await capsule.click();
          assert.equal(await page.locator('[data-activity-result="failed"]').count(), 0);
        } finally {
          await page.close();
        }
      });
    }
  }

  for (const theme of ["light", "dark"]) {
    test(`all completed actor badges remain unobscured ${theme}`, async () => {
      const page = await getBrowser().newPage();
      try {
        await page.goto(
          `${getOrigin()}fixture?real=1&workflow=1&endedOnly=1&mixedActors=1&allActorsDone=1&theme=${theme}&locale=en-US`,
        );
        const capsule = page.locator('[data-status-capsule="activity"]');
        const badges = capsule.locator(
          '[data-subagent-avatar] [data-agent-result-badge="completed"]',
        );
        assert.equal(await badges.count(), 3);
        assert.equal(await capsule.locator("[data-agent-result-badge]").count(), 3);
        for (const badge of await badges.all()) {
          assert.equal(
            await badge.evaluate((node) => {
              // Button 默认关闭 SVG 命中；仅为遮挡检测打开，不改变视觉或层级。
              node.ownerSVGElement.style.pointerEvents = "all";
              for (const child of node.querySelectorAll("*")) child.style.pointerEvents = "all";
              const r = node.getBoundingClientRect();
              return node.contains(
                document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
              );
            }),
            true,
          );
        }
        await page.screenshot({ path: join(artifacts, `all-actor-badges-${theme}.png`) });
      } finally {
        await page.close();
      }
    });
  }

  for (const theme of ["light", "dark"]) {
    test(`Workflow capsule preserves each actor state ${theme}`, async () => {
      const page = await getBrowser().newPage({ viewport: { width: 390, height: 900 } });
      try {
        await page.goto(
          `${getOrigin()}fixture?real=1&workflow=1&mixedActors=1&theme=${theme}&locale=en-US`,
        );
        const capsule = page.locator('[data-status-capsule="activity"]');
        const avatars = capsule.locator("[data-subagent-avatar]");
        assert.equal(await avatars.count(), 3);
        assert.equal(await capsule.locator('[data-agent-result-badge="completed"]').count(), 1);
        assert.equal(await avatars.nth(0).getAttribute("data-face-state"), "content");
        assert.equal(await avatars.nth(1).getAttribute("data-face-state"), "scanning");
        assert.equal(await avatars.nth(2).getAttribute("data-face-state"), "waiting");
        await page.screenshot({ path: join(artifacts, `individual-actor-${theme}.png`) });
      } finally {
        await page.close();
      }
    });
  }

  for (const width of [390, 1200]) {
    for (const theme of ["light", "dark"]) {
      test(`Chinese Activity capsule uses active label ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          await page.goto(`${getOrigin()}fixture?real=1&theme=${theme}&locale=zh-CN`);
          const capsule = page.locator('[data-status-capsule="activity"]');
          // 窄屏按既有响应式规则收起文字，仍用同一中文无障碍名称。
          if (width === 390) assert.equal(await capsule.getAttribute("aria-label"), "活跃中");
          else assert.match(await capsule.innerText(), /活跃/);
        } finally {
          await page.close();
        }
      });
    }
  }

  for (const status of ["success", "failed", "cancelled"]) {
    for (const endedAt of [4, 14]) {
      test(`cold seeded ${status} result respects input boundary ${endedAt}`, async () => {
        const page = await getBrowser().newPage();
        try {
          await page.goto(
            `${getOrigin()}fixture?real=1&theme=dark&locale=en-US&endedOnly=1&onlySubagentHistory=1&agentStatus=${status}&childEndedAt=${endedAt}`,
          );
          await page.getByTestId("dismiss-activity").click();
          const capsule = page.locator('[data-status-capsule="activity"]');
          await capsule.click();
          await page.getByTestId("activity-subagent-directory").waitFor();
          assert.equal(await page.locator("[data-activity-result]").count(), endedAt > 10 ? 1 : 0);
          if (endedAt <= 10) {
            assert.equal(
              (await capsule.innerText()).replace(/\s+/g, " "),
              `Completed ${status === "success" ? 1 : 0}`,
            );
            assert.equal(
              await page.locator("[data-agent-result-badge]").count(),
              status === "success" ? 1 : 0,
            );
          } else {
            const result = { success: "completed", failed: "failed", cancelled: "stopped" }[status];
            assert.equal(
              await page.locator("[data-activity-result]").getAttribute("data-activity-result"),
              result,
            );
            assert.equal(
              await capsule
                .locator("[data-agent-result-badge]")
                .getAttribute("data-agent-result-badge"),
              result,
            );
            assert.equal(
              await page
                .locator(`[data-activity-result] [data-agent-result-badge="${result}"]`)
                .count(),
              1,
            );
          }
        } finally {
          await page.close();
        }
      });
    }
  }

  test("accepted input keeps running activity alongside history", async () => {
    const page = await getBrowser().newPage();
    try {
      await page.goto(`${getOrigin()}fixture?real=1&theme=light&locale=en-US`);
      await page.getByTestId("dismiss-activity").click();
      const capsule = page.locator('[data-status-capsule="activity"]');
      assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
      await capsule.click();
      await page.getByTestId("activity-subagent-directory").waitFor();
      await page.getByTestId("v4-running-subagent-stop").waitFor();
    } finally {
      await page.close();
    }
  });

  for (const width of [390, 1200]) {
    for (const theme of ["light", "dark"]) {
      test(`previous directories coexist with current completed terminal ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          await page.goto(`${getOrigin()}fixture?real=1&theme=${theme}&locale=en-US&endedOnly=1`);
          await page.getByTestId("dismiss-activity").click();
          await page.getByTestId("new-terminal").click();
          await page.locator('[data-status-capsule="activity"]').click();
          await page.getByText("Current round terminal", { exact: true }).waitFor();
          for (const kind of ["subagent", "workflow"]) {
            if (kind === "workflow") await page.locator('[data-status-capsule="activity"]').click();
            const entry = page.getByTestId(`activity-${kind}-directory`);
            assert.equal(await entry.count(), 1, "本轮结果不能隐藏上一轮目录");
            await entry.click();
            assert.equal(
              await page.locator("output").textContent(),
              `${kind === "subagent" ? "agent" : "workflow"}-history:parent`,
            );
          }
          await page.screenshot({
            path: join(artifacts, `activity-history-current-${width}-${theme}.png`),
          });
        } finally {
          await page.close();
        }
      });
    }
  }

  test("directory visibility follows each archived kind independently", async () => {
    const page = await getBrowser().newPage();
    try {
      await page.goto(
        `${getOrigin()}fixture?real=1&theme=light&locale=en-US&endedOnly=1&onlySubagentHistory=1`,
      );
      await page.locator('[data-status-capsule="activity"]').click();
      assert.equal(await page.getByTestId("activity-subagent-directory").count(), 0);
      assert.equal(await page.getByTestId("activity-workflow-directory").count(), 0);
      await page.getByTestId("dismiss-activity").click();
      await page.getByTestId("new-terminal").click();
      await page.locator('[data-status-capsule="activity"]').click();
      await page.getByTestId("activity-subagent-directory").waitFor();
      assert.equal(await page.getByTestId("activity-workflow-directory").count(), 0);
    } finally {
      await page.close();
    }
  });
  for (const width of [390, 1280])
    for (const theme of ["light", "dark"]) {
      test(`capsule navigation closes portal ${width}/${theme}`, async () => {
        const page = await getBrowser().newPage({ viewport: { width, height: 900 } });
        try {
          for (const item of [
            {
              capsule: "activity",
              query: "",
              selector: "[data-running-subagent-session-trigger]",
              result: "agent-details",
            },
            {
              capsule: "activity",
              query: "&workflow=1",
              selector: '[data-testid="background-bash-open"]',
              result: "bash-details",
            },
            {
              capsule: "git",
              query: "",
              selector: '[data-testid="status-git-files"] button',
              result: "unstaged:shared.txt",
            },
            {
              capsule: "git",
              query: "",
              selector: '[data-testid="status-git-view-all"]',
              result: "git-details",
            },
          ]) {
            await page.goto(
              getOrigin() + `fixture?real=1&theme=${theme}&locale=en-US` + item.query,
            );
            await page.locator(`[data-status-capsule="${item.capsule}"]`).click();
            await page.locator(item.selector).first().click();
            assert.equal(await page.locator("output").innerText(), item.result);
            await page.locator("[data-status-capsule-content]").waitFor({ state: "hidden" });
          }
        } finally {
          await page.close();
        }
      });
    }

  test("workflow journal distinguishes pending, empty and unavailable; ignores stale response", async () => {
    const page = await getBrowser().newPage();
    try {
      await page.goto(getOrigin() + "fixture?journalQuery=1");
      await page.getByTestId("query-state").waitFor();
      assert.equal(await page.getByTestId("query-state").innerText(), "loading");
      await page.waitForFunction(() => window.workflowRequests.length === 1);
      await page.getByRole("button", { name: "Switch query" }).click();
      await page.waitForFunction(() => window.workflowRequests.length === 2);
      await page.evaluate(() => window.workflowRequests[0].resolve({ runs: [{ runId: "old" }] }));
      assert.equal(await page.getByTestId("query-state").innerText(), "loading");
      await page.evaluate(() => window.workflowRequests[1].resolve({ runs: [] }));
      await page.waitForFunction(
        () => document.querySelector('[data-testid="query-state"]').textContent === "[]",
      );
      await page.reload();
      await page.waitForFunction(() => window.workflowRequests.length === 1);
      assert.equal(await page.getByTestId("query-state").innerText(), "loading");
      await page.evaluate(() =>
        window.workflowRequests[0].reject(new Error("capabilityUnsupported")),
      );
      await page.waitForFunction(
        () => document.querySelector('[data-testid="query-state"]').textContent === "unavailable",
      );
    } finally {
      await page.close();
    }
  });
  test("workflow actors are counted once alongside terminal tasks", async () => {
    const page = await getBrowser().newPage();
    try {
      await page.goto(getOrigin() + "fixture?theme=light&locale=en-US&real=1&workflow=1");
      const activity = page.locator('[data-status-capsule="activity"]');
      await activity.waitFor();
      assert.equal((await activity.innerText()).replace(/\s+/g, " "), "Active 2");
      assert.equal(await activity.locator("[data-status-capsule-secondary]").innerText(), "2");
      const secondarySizes = await page
        .locator("[data-status-capsule-secondary]")
        .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontSize));
      assert.ok(secondarySizes.length >= 4);
      assert.ok(secondarySizes.every((size) => size === "12px"));
      await activity.click();
      assert.equal(await page.getByTestId("v4-running-subagent-item").count(), 0);
      assert.deepEqual(
        await page
          .locator("[data-activity-id]")
          .evaluateAll((nodes) => nodes.map((n) => n.dataset.activityId)),
        ["workflow:run", "bash:shell"],
      );
      await page.locator("[data-workflow-run-details-trigger]").click();
      assert.equal(await page.locator("output").innerText(), "workflow-details");
      await page.locator('[data-status-capsule-content="activity"]').waitFor({ state: "hidden" });
    } finally {
      await page.close();
    }
  });
}

export const workflowQueryFixture = `const requests=[];
window.workflowRequests=requests;
const queryContext={workflowRuns:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))};
function QueryProbe(){
 const [session,setSession]=useState("a");
 const data=useWorkflowRunJournalSummaries({sessionId:session,live:true});
 return <><button onClick={()=>setSession("b")}>Switch query</button><output data-testid="query-state">{data===undefined?"loading":data===null?"unavailable":JSON.stringify(data)}</output></>;
}
`;
