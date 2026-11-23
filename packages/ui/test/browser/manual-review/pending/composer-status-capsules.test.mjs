// ST01–ST12：胶囊布局、真实状态详情与控制回调的可重复浏览器场景。
import { registerActivityHistoryCases, workflowQueryFixture } from "./activity-history-cases.mjs";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = join(root, "composer-status-fixture.tsx");
const artifacts = join(root, "packages/desktop/.e2e-artifacts/composer-status-capsules-browser");
const fixture = `
import { useState } from "react";
import { AgentToolCallBlock } from "@/ToolCallBlocks/renderers/agent.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { V4ConversationContext } from "@/v4/V4ConversationContext.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { subagentProjectionStateSchema } from "@zcode/shared/zcode-protocol-v4";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ComposerStatusRow, StatusCapsule, ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { GitStatusRepositoryContext } from "@/hooks/useGitRepository.js";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";
const query = new URLSearchParams(location.search);
const theme = query.get("theme");
document.documentElement.className = theme + " theme-zai-" + theme;
${workflowQueryFixture}
function Fixture() {
 const [session, setSession] = useState("a");
 const [goalStatus, setGoalStatus] = useState("active");
 const [todoVisible, setTodoVisible] = useState(true);
 const [todoState, setTodoState] = useState("pending");
 const [gitVisible, setGitVisible] = useState(true);
 const [result, setResult] = useState("");
 const [activityEnded, setActivityEnded] = useState(query.has("endedOnly"));
 const [workflowStatus, setWorkflowStatus] = useState(query.has("actorParentEnd") ? "running" : query.get("runStatus"));

 const [activityDismissed, setActivityDismissed] = useState(false);
 const [newTerminal, setNewTerminal] = useState(false);
 const [terminalRunning, setTerminalRunning] = useState(false);
 const real = query.has("real");
 if(query.has("journalQuery")) return <V4ConversationContext.Provider value={queryContext}><QueryProbe/></V4ConversationContext.Provider>;
 return <ZCodeIntlProvider initialLocale={query.get("locale")}>
  <ToolPresentationCapabilitiesProvider value={query.has("configuredColor") ? {agentColor:()=>"blue"} : {}}><TooltipProvider><main className="h-screen bg-background text-foreground p-3">
   <button data-testid="outside">Outside</button><button data-testid="toggle" onClick={()=>setTodoVisible(v=>!v)}>Toggle</button><output>{result}</output>
   <button data-testid="todo-running" onClick={()=>setTodoState("inProgress")}>Run todo</button>
   <button data-testid="todo-complete" onClick={()=>setTodoState("completed")}>Complete todo</button>
   <button data-testid="clear-git" onClick={()=>setGitVisible(false)}>Clear git</button>
   <button data-testid="dismiss-activity" onClick={()=>setActivityDismissed(true)}>Accept next input</button>
   <button data-testid="start-terminal" onClick={()=>{setNewTerminal(true);setTerminalRunning(true)}}>Start terminal</button>
   <button data-testid="new-terminal" onClick={()=>{setNewTerminal(true);setTerminalRunning(false)}}>Complete new terminal</button>
   <button data-testid="settle-workflow" onClick={()=>setWorkflowStatus(query.get("runStatus"))}>Settle workflow</button>
   <button data-testid="end-activity" onClick={()=>setActivityEnded(true)}>End activity</button>
   <button data-testid="session" onClick={()=>setSession(value=>value === "a" ? "b" : "a")}>Session</button>
   {query.has("configuredColor") ? <section data-testid="message-agent"><AgentToolCallBlock toolCallNode={{toolCall:{toolId:"identity",name:"Agent",title:"Agent",status:"pending",input:{subagent_type:"reviewer",description:"Still running"}},childToolCalls:[]}} workspacePath="/example" isRunning={true} statusLabel="Running" nestedToolRenderer={()=>null}/></section> : null}
   <div className="fixed bottom-4 left-4 right-4">
    {query.has("banner") ? <ChatErrorBanner error={{code:"LAYOUT_SAMPLE",message:"Current model unavailable"}} /> : null}
    <GitStatusRepositoryContext.Provider value={{workspacePath:"/example",openChange:(path,source)=>setResult(source+":"+path),state:{datasets:{
     unstaged:{sections:gitVisible ? [{changes:query.has("manyFiles") ? Array.from({length:40},(_,i)=>({path:"file-"+i+".txt",added:1,removed:0})) : [{path:"shared.txt",added:2,removed:1},{path:"image.png",added:0,removed:0}]}] : []},
     staged:{sections:gitVisible ? [{changes:[{path:"shared.txt",added:1,removed:0}]}] : []}
    }}}}>
    <ComposerStatusRow key={session}>
     {real ? <ConversationStatusPanel workspacePath="/example" parentSessionId="parent"
      goal={{targetId:"g",objective:"Full objective for capsule verification",summaryTitle:query.has("long") ? "Long objective title for verifying capsule responsive shrinking and trailing mask" : "Short objective",status:goalStatus,summaryHidden:query.has("goalHidden"),timeUsedSeconds:12,activeRunStartedAtMs:null,iteration:0,verifications:[],iterations:[]}}
      gitSummary={{isRepository:true,branchName:"feature/current-branch-with-a-long-name-for-overflow",headRefType:"branch"}} gitWorktreeChangeSummary={{added:3,removed:1}}
      sessionPlans={[{rowId:1,toolCallId:"p1",toolName:"ExitPlanMode",status:"success",input:{plan:"# Older plan"}},{rowId:2,toolCallId:"p2",toolName:"ExitPlanMode",status:"success",input:{plan:query.has("long") ? "# Latest plan with a very long title for responsive layout verification" : "# Latest plan"}}]}
      onPauseGoal={()=>setGoalStatus("paused")} onResumeGoal={()=>setGoalStatus("active")}
      plan={todoVisible ? {items:[{id:"first",content:"First completed step",status:"completed"},{id:"second",content:"Second pending step",status:todoState}]} : null}
      workflowRuns={query.has("workflow") ? [{runId:"run",toolCallId:"wf",status:workflowStatus || (activityEnded ? "completed" : "running"),actors:[{sessionId:"child",siteId:"explorer",ordinal:0,status:query.has("mixedActors") ? "completed" : "running"},{sessionId:"child-2",siteId:"reviewer",ordinal:1,status:query.has("allActorsDone") ? "completed" : "running"},{sessionId:"child-3",siteId:"tester",ordinal:2,status:query.has("allActorsDone") ? "completed" : query.has("mixedActors") ? "waiting" : "running"}].map(actor=>query.has("waitingActors") ? {...actor,status:"waiting"} : actor),nodes:[],usage:{}}] : []}
      backgroundWorks={[...(query.has("resultMix") ? query.get("resultMix").split(",").map((status,i)=>({workId:"mixed-"+i,kind:"bash",title:"Result "+i,status,startedAt:1,endedAt:4})) : []), ...(query.has("actorParentEnd") ? [{workId:"run",kind:"workflow",title:"Workflow inspection",status:workflowStatus === "running" ? "running" : workflowStatus === "stopped" ? "cancelled" : "failed",startedAt:2}] : query.has("workflow") ? [{workId:"run",kind:"workflow",title:"Workflow inspection",status:activityEnded ? "resultPending" : "running",startedAt:2},{workId:"shell",kind:"bash",title:"Build project",status:activityEnded ? "resultPending" : "running",startedAt:3}] : []), ...(newTerminal ? [{workId:"new-shell",kind:"bash",title:"Current round terminal",status:terminalRunning ? "running" : "resultPending",startedAt:11,endedAt:15}] : [])]}
      onOpenBackgroundBash={()=>setResult("bash-details")} onOpenGitReview={()=>setResult("git-details")} onOpenWorkflowRun={()=>setResult("workflow-details")} onCancelBackgroundWork={id=>setResult("stop:"+id)}
      activitySummaryDismissed={activityDismissed ? {at:10,workIds:["shell","run"],subagentIds:["child"],workflowRunIds:query.has("onlySubagentHistory") ? [] : ["run"]} : undefined}
      completedActivityCount={query.get("completedTotal") === "unknown" ? null : query.has("completedTotal") ? Number(query.get("completedTotal")) : undefined}
      endedSubagents={activityEnded && !query.has("resultMix") ? subagentProjectionStateSchema.shape.ended.unwrap().parse([{childSessionId:"child",subagentType:"explorer",title:"Inspect files",summary:query.get("agentSummary") ?? "Inspection complete",status:query.get("agentStatus") || "success",startedAt:1,endedAt:Number(query.get("childEndedAt") || 4)}]) : []}
      runningSubagents={query.has("mixedAgents") ? Array.from({length:Number(query.get("runningCount") || 1)},(_,i)=>({childSessionId:"live-child-"+i,subagentType:"reviewer",title:"Still running "+i,status:"running",startedAt:2+i})) : activityEnded ? [] : [{childSessionId:"child",subagentType:"explorer",title:"Inspect files",status:"running",startedAt:1,stopControl:{taskId:"task",executionId:"execution"}}]}
      onStopSubagent={control=>setResult(control.taskId + ":" + control.executionId)}
      onOpenSubagentSession={()=>setResult("agent-details")}
      endedSubagentCount={query.has("noHistory") ? 0 : 2} onOpenSubagentDirectory={query.has("noDirectoryHost") ? undefined : request=>setResult("agent-history:"+request.parentSessionId)}
      endedWorkflowRunCount={query.has("noHistory") ? 0 : 3} onOpenWorkflowRunDirectory={query.has("noDirectoryHost") ? undefined : request=>setResult("workflow-history:"+request.parentSessionId)}
     /> : ["goal", "todo", "git", "activity"].map(id=>
      <StatusCapsule key={id} id={id} label={id} icon={<span>•</span>}>
       <div data-testid={id + "-detail"}>{id} detail</div>
      </StatusCapsule>)}
    </ComposerStatusRow></GitStatusRepositoryContext.Provider>
    <textarea aria-label="Composer" className="w-full" />
   </div>
  </main></TooltipProvider></ToolPresentationCapabilitiesProvider>
 </ZCodeIntlProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "composer-status-fixture",
        resolveId(id) {
          if (id === "/composer-status-fixture.tsx") return entry;
        },
        load(id) {
          if (id === entry) return fixture;
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/composer-status-fixture.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": join(root, "packages/ui/src"),
        "@zcode/shared/zcode-protocol-v4": join(
          root,
          "packages/shared/src/zcode-protocol-v4/index.ts",
        ),
      },
    },
    optimizeDeps: {
      entries: [],
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "class-variance-authority",
        "clsx",
        "lucide-react",
        "radix-ui",
        "tailwind-merge",
        "zod",
        "zustand",
      ],
    },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  // 半像素边框需要真实 2x 栅格；仅设置页面 deviceScaleFactor 仍可能按 1x 取整。
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? {
          executablePath: process.env.CHROME_EXECUTABLE_PATH,
          args: ["--force-device-scale-factor=2"],
        }
      : { channel: "chrome", args: ["--force-device-scale-factor=2"] },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      test(`capsules ${mobile ? "touch" : "desktop"}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 390 : 1200, height: 844 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        try {
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
          const triggers = page.locator("[data-status-capsule]");
          await triggers.first().waitFor();
          assert.deepEqual(
            await triggers.evaluateAll((nodes) => nodes.map((n) => n.dataset.statusCapsule)),
            ["goal", "todo", "git", "activity"],
          );
          for (const id of ["goal", "todo", "activity"]) {
            await page.locator(`[data-status-capsule="${id}"]`).click();
            await page.getByTestId(id + "-detail").waitFor();
            assert.equal(await page.locator("[data-status-capsule-content]").count(), 1);
            const box = await page.locator("[data-status-capsule-content]").boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= (mobile ? 390 : 1200) && box.y >= 0);
          }
          await page.screenshot({ path: join(artifacts, `${mobile}-${theme}-${locale}.png`) });
          await page.keyboard.press("Escape");
          await page.locator("[data-status-capsule-content]").waitFor({ state: "hidden" });
          await page.locator('[data-status-capsule="todo"]').click();
          await page.getByTestId("session").click();
          await page.locator("[data-status-capsule-content]").waitFor({ state: "hidden" });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });

test("real Goal, Todo and activity controls preserve their owners", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(origin + "fixture?theme=light&locale=en-US&real=1");
    const todo = page.locator('[data-status-capsule="todo"]');
    await todo.waitFor();
    assert.match(await todo.innerText(), /Pending\s*1\/2/);
    await todo.click();
    assert.deepEqual(await page.locator("[data-plan-status]").allTextContents(), [
      "First completed step",
      "Second pending step",
    ]);
    await page.getByTestId("toggle").click();
    await todo.waitFor({ state: "hidden" });
    await page.getByTestId("toggle").click();
    await todo.waitFor();
    assert.equal(await page.locator("[data-status-capsule-content]").count(), 0);
    await page.locator('[data-status-capsule="goal"]').click();
    await page.locator('[data-goal-action="pause"]').click();
    await page.locator('[data-goal-action="resume"]').waitFor();
    assert.match(await page.locator('[data-status-capsule="goal"]').innerText(), /Paused/);
    await page.locator('[data-goal-action="resume"]').click();
    await page.locator('[data-goal-action="pause"]').waitFor();
    await page.locator('[data-status-capsule="activity"]').click();
    await page.getByTestId("v4-running-subagent-stop").click();
    assert.equal(await page.locator("output").innerText(), "task:execution");
    await page.locator("[data-running-subagent-session-trigger]").click();
    assert.equal(await page.locator("output").innerText(), "agent-details");
    assert.equal(await page.locator("summary").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Plan capsule is absent and staged Git source keeps stable identity", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin + "fixture?theme=dark&locale=en-US&real=1");
    await page.locator('[data-status-capsule="git"]').waitFor();
    assert.equal(await page.locator('[data-status-capsule="plans"]').count(), 0);
    const git = page.locator('[data-status-capsule="git"]');
    assert.match(await git.innerText(), /2 files changed/);
    await git.click();
    const content = page.locator('[data-status-capsule-content="git"]');
    await content.getByRole("button", { name: /shared.txt Staged/ }).click();
    assert.equal(await page.locator("output").innerText(), "staged:shared.txt");
    await content.waitFor({ state: "hidden" });
    await git.click();
    await content.getByRole("button", { name: /image.png Unstaged Changed/ }).click();
    assert.equal(await page.locator("output").innerText(), "unstaged:image.png");
  } finally {
    await page.close();
  }
});

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      test(`restored error banner ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 844 },
          deviceScaleFactor: 2,
        });
        try {
          await page.goto(origin + `fixture?theme=${theme}&locale=${locale}&real=1&banner=1`);
          const banner = page.locator('[data-error-code="LAYOUT_SAMPLE"]');
          await banner.waitFor();
          assert.equal(await page.locator('[data-status-capsule="alerts"]').count(), 0);
          assert.equal(await page.locator("[data-status-capsule-content]").count(), 0);
          assert.equal(await banner.getByRole("button").count(), 2);
          assert.equal(await banner.evaluate((el) => getComputedStyle(el).borderTopWidth), "0.5px");
          await page.screenshot({
            path: join(artifacts, `restored-error-${width}-${theme}-${locale}.png`),
          });
        } finally {
          await page.close();
        }
      });

// Todo 没有可聚焦按钮，键盘打开后焦点落在面板，曾被全局焦点重置清掉外投影。
for (const theme of ["light", "dark"])
  test(`status panel keeps shadow and center alignment on focus/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    try {
      await page.goto(origin + `fixture?theme=${theme}&locale=en-US&real=1`);
      const trigger = page.locator('[data-status-capsule="todo"]');
      await trigger.focus();
      await page.keyboard.press("Enter");
      const panel = page.locator('[data-status-capsule-content="todo"]');
      await panel.waitFor();
      await panel.evaluate(async (el) => {
        await Promise.all(el.getAnimations().map((animation) => animation.finished));
      });
      assert.equal(await panel.evaluate((el) => el === document.activeElement), true);
      assert.notEqual(await panel.evaluate((el) => getComputedStyle(el).boxShadow), "none");
      assert.equal(await panel.getAttribute("data-align"), "center");
    } finally {
      await page.close();
    }
  });

test("legacy hidden Goal remains visible as session state", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin + "fixture?theme=light&locale=en-US&real=1&goalHidden=1");
    await page.locator('[data-status-capsule="todo"]').waitFor();
    assert.equal(await page.locator('[data-status-capsule="goal"]').count(), 1);
    assert.equal(await page.locator('[data-status-capsule="plans"]').count(), 0);
  } finally {
    await page.close();
  }
});

for (const width of [390, 1200]) {
  for (const theme of ["light", "dark"]) {
    test(`activity changes from result to history on accepted input ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(origin + `fixture?theme=${theme}&locale=en-US&real=1`);
        const capsule = page.locator('[data-status-capsule="activity"]');
        await capsule.click();
        assert.equal(await page.locator("summary").count(), 0);
        await page.getByTestId("end-activity").click();
        assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
        await capsule.click();
        assert.equal(await page.locator('[data-activity-result="completed"]').count(), 1);
        assert.equal(await page.getByRole("button", { name: /Stop/ }).count(), 0);
        assert.equal(await page.getByTestId("activity-subagent-directory").count(), 0);
        await page.getByTestId("dismiss-activity").click();
        await capsule.waitFor({ state: "visible" });
        assert.equal(await capsule.locator("[data-status-capsule-secondary]").innerText(), "1");
        await capsule.click();
        await page.getByTestId("activity-subagent-directory").waitFor();
        assert.equal(await page.locator("[data-activity-result]").count(), 0);
        assert.equal(await capsule.locator("[data-subagent-avatar]").count(), 1);
        await page.goto(origin + `fixture?theme=${theme}&locale=en-US&real=1&endedOnly=1`);
        await page.locator('[data-status-capsule="todo"]').waitFor();
        await capsule.waitFor();
      } finally {
        await page.close();
      }
    });
  }
}

// 使用真实四类内容；逐项保存测量证据，不能以空标签夹具代替窄屏验收。
for (const width of [390, 600, 1200]) {
  for (const theme of ["light", "dark"]) {
    for (const locale of ["zh-CN", "en-US"]) {
      test(`real capsule geometry ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          hasTouch: width === 390,
          isMobile: width === 390,
        });
        page.setDefaultTimeout(10000);
        const name = `geometry-${width}-${theme}-${locale}`;
        try {
          await page.goto(
            `${origin}fixture?theme=${theme}&locale=${locale}&real=1&workflow=1&long=1`,
          );
          await page.locator('[data-status-capsule="activity"]').waitFor();
          const result = await page
            .locator('[data-testid="composer-status-row"]')
            .evaluate((row) => {
              const probe = document.createElement("span");
              probe.style.cssText =
                "background:var(--color-input);border:0.5px solid var(--color-input-border);";
              probe.className = "shadow-(--shadow-composer-soft)";
              row.append(probe);
              const probeStyle = getComputedStyle(probe);
              const expected = {
                background: probeStyle.backgroundColor,
                borderColor: probeStyle.borderTopColor,
                shadow: probeStyle.boxShadow,
              };
              probe.remove();
              const rect = row.getBoundingClientRect();
              return {
                expected,
                row: {
                  left: rect.left,
                  right: rect.right,
                  width: rect.width,
                  scrollWidth: row.scrollWidth,
                },
                items: [...row.querySelectorAll("[data-status-capsule]")].map((el) => {
                  const box = el.getBoundingClientRect(),
                    css = getComputedStyle(el),
                    title = el.children[1],
                    info = el.querySelector("[data-status-capsule-secondary]");
                  const icon = el.children[0].querySelector("svg");
                  const iconBox = icon?.getBoundingClientRect();
                  return {
                    id: el.dataset.statusCapsule,
                    left: box.left,
                    right: box.right,
                    top: box.top,
                    height: box.height,
                    paddingLeft: css.paddingLeft,
                    paddingRight: css.paddingRight,
                    gap: css.columnGap,
                    border: css.borderTopWidth,
                    background: css.backgroundColor,
                    borderColor: css.borderTopColor,
                    shadow: css.boxShadow,
                    titleFont: getComputedStyle(title).fontSize,
                    titleWidth: title.getBoundingClientRect().width,
                    secondary: info
                      ? {
                          left: info.getBoundingClientRect().left,
                          right: info.getBoundingClientRect().right,
                          font: getComputedStyle(info).fontSize,
                          width: info.clientWidth,
                          scrollWidth: info.scrollWidth,
                        }
                      : null,
                    icon: iconBox ? { width: iconBox.width, height: iconBox.height } : null,
                  };
                }),
              };
            });
          await writeFile(join(artifacts, name + ".json"), JSON.stringify(result, null, 2));
          await page.screenshot({ path: join(artifacts, name + ".png") });
          assert.deepEqual(
            result.items.map((x) => x.id),
            ["goal", "todo", "git", "activity"],
          );
          for (const item of result.items) {
            assert.equal(item.height, 32, `${item.id} height`);
            assert.equal(item.paddingLeft, "8px");
            assert.equal(item.paddingRight, "10px");
            assert.equal(item.gap, width <= 640 ? "4px" : "6px");
            assert.equal(item.border, "0.5px");
            assert.equal(item.background, result.expected.background);
            assert.equal(item.borderColor, result.expected.borderColor);
            assert.equal(item.shadow, result.expected.shadow);
            assert.equal(item.titleFont, "14px");
            assert.equal(item.icon.width, 16);
            assert.equal(item.icon.height, 16);
            assert.ok(
              item.left >= result.row.left - 0.5 && item.right <= result.row.right + 0.5,
              `${item.id} outside row`,
            );
            if (item.secondary) {
              assert.equal(item.secondary.font, "12px");
              assert.ok(
                item.secondary.left >= item.left && item.secondary.right <= item.right,
                `${item.id} fixed slot outside capsule`,
              );
              assert.ok(
                item.secondary.scrollWidth <= item.secondary.width + 1,
                `${item.id} secondary clipped`,
              );
            }
          }
          assert.ok(
            Math.max(...result.items.map((x) => x.top)) -
              Math.min(...result.items.map((x) => x.top)) <
              1,
          );
          assert.ok(result.row.scrollWidth <= result.row.width + 1, "row overflows horizontally");
          const rowPadding = await page.getByTestId("composer-status-row").evaluate((node) => ({
            top: getComputedStyle(node).paddingTop,
            bottom: getComputedStyle(node).paddingBottom,
          }));
          assert.deepEqual(rowPadding, { top: "0px", bottom: "16px" });
          const body = page.locator('[data-status-capsule="activity"] .wf-face-body').first();
          assert.equal(await body.getAttribute("rx"), "7");
          assert.equal(await body.getAttribute("paint-order"), "stroke fill");
          assert.equal(await body.getAttribute("vector-effect"), "non-scaling-stroke");
          const title = page.locator('[data-status-capsule="goal"] [class*="mask-image"]');
          if (width < 1200) assert.equal(await title.count(), 1, "long title must fade");
          for (const id of ["todo", "git", "activity"]) {
            const label = await page
              .locator(`[data-status-capsule="${id}"] [data-capsule-label]`)
              .evaluate((node) => ({
                position: getComputedStyle(node).position,
                visibility: getComputedStyle(node).visibility,
              }));
            if (label.visibility === "hidden") assert.equal(label.position, "absolute");
          }
          for (const id of ["goal", "todo", "git", "activity"]) {
            const capsule = page.locator(`[data-status-capsule="${id}"]`);
            await capsule.click();
            const panel = page.locator(`[data-status-capsule-content="${id}"]`);
            await panel.waitFor();
            assert.equal(await page.locator("[data-status-capsule-content]").count(), 1);
            assert.equal(await panel.getAttribute("data-align"), "center");
            const box = await panel.boundingBox();
            assert.ok(box.width <= 320.5 && box.x >= 0 && box.x + box.width <= width + 0.5);
            await page.waitForFunction(() =>
              document
                .querySelector("[data-status-capsule-content]")
                ?.contains(document.activeElement),
            );
            const tooltipCount = await page.getByRole("tooltip").count();
            await writeFile(
              join(artifacts, `${name}-${id}-focus.json`),
              JSON.stringify({
                tooltipCount,
                active: await page.evaluate(() => document.activeElement?.outerHTML),
              }),
            );
            await page.keyboard.press("Escape");
            if (tooltipCount > 0) {
              await page.getByRole("tooltip").waitFor({ state: "hidden" });
              await page.keyboard.press("Escape");
            }
            await panel.waitFor({ state: "hidden" });
          }
        } finally {
          await page.close();
        }
      });
    }
  }
}

test("Todo states and Git clearing follow supplied projections", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}fixture?theme=light&locale=en-US&real=1`);
    const todo = page.locator('[data-status-capsule="todo"]');
    await todo.waitFor();
    await page.getByTestId("todo-running").click();
    assert.match(await todo.innerText(), /In progress/);
    await todo.click();
    assert.equal(await page.locator('[data-plan-status="inProgress"]').count(), 1);
    await page.getByTestId("todo-complete").click();
    assert.match(await todo.innerText(), /Completed/);
    assert.equal(await todo.locator("[data-status-capsule-secondary]").innerText(), "2/2");
    const git = page.locator('[data-status-capsule="git"]');
    await git.click();
    await page.getByTestId("clear-git").click();
    await git.waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-status-capsule-content="git"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("completed workflow and resultPending terminal preserve Activity", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}fixture?theme=dark&locale=en-US&real=1&workflow=1`);
    const activity = page.locator('[data-status-capsule="activity"]');
    await activity.click();
    await page.getByTestId("end-activity").click();
    assert.equal(await activity.locator("[data-status-capsule-secondary]").innerText(), "2");
    await activity.click();
    assert.equal(await page.locator('[data-activity-result="completed"]').count(), 2);
    await page.getByTestId("dismiss-activity").click();
    await activity.waitFor({ state: "visible" });
  } finally {
    await page.close();
  }
});

// 只验收结束徽标的真实 SVG 和布局，不改变产品状态或模拟控制命令。
for (const width of [390, 1200]) {
  for (const theme of ["light", "dark"]) {
    for (const [status, result] of [
      ["success", "completed"],
      ["cancelled", "stopped"],
      ["failed", "failed"],
    ]) {
      test(`activity badge parity ${result}/${width}/${theme}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          isMobile: width === 390,
          hasTouch: width === 390,
        });
        try {
          await page.goto(
            origin + `fixture?theme=${theme}&locale=en-US&real=1&agentStatus=${status}`,
          );
          const capsule = page.locator('[data-status-capsule="activity"]');
          await capsule.waitFor();
          await page.getByTestId("end-activity").click();
          await capsule.click();
          const panel = page.locator('[data-status-capsule-content="activity"]');
          await panel.waitFor();
          // 面板有入场缩放，等真实动画完成后再测量，不能把动画中尺寸当成布局尺寸。
          await panel.evaluate(async (el) => {
            await Promise.all(
              el
                .getAnimations({ subtree: true })
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
            );
          });
          const expectedExpression =
            result === "stopped" ? "pill" : result === "failed" ? "sad" : "happy";
          for (const owner of [capsule, panel]) {
            const avatar = owner.locator("[data-subagent-avatar]").first();
            assert.equal(await avatar.getAttribute("data-expression"), expectedExpression);
            if (result === "stopped")
              assert.equal(await avatar.getAttribute("data-motion"), "idle");
          }
          const selector = `[data-agent-result-badge="${result}"]`;
          const triggerBadge = capsule.locator(selector);
          const panelBadge = panel.locator(selector);
          assert.equal(await triggerBadge.count(), 1);
          assert.equal(await panelBadge.count(), 1);
          assert.equal(await triggerBadge.innerHTML(), await panelBadge.innerHTML());
          for (const badge of [triggerBadge, panelBadge]) {
            const geometry = await badge.evaluate((el) => {
              const badgeRect = el.getBoundingClientRect();
              const svgRect = el.ownerSVGElement.getBoundingClientRect();
              return {
                svgWidth: svgRect.width,
                svgHeight: svgRect.height,
                cx: badgeRect.x + badgeRect.width / 2 - svgRect.x,
                cy: badgeRect.y + badgeRect.height / 2 - svgRect.y,
                width: badgeRect.width,
              };
            });
            assert.equal(geometry.svgWidth, 16);
            assert.equal(geometry.svgHeight, 16);
            assert.ok(geometry.cx < 8 && geometry.cy > 8, JSON.stringify(geometry));
            assert.ok(Math.abs(geometry.width - 8.8) < 0.3, JSON.stringify(geometry));
          }
          if (result === "stopped") {
            assert.equal(await triggerBadge.locator('rect[width="4"][height="4"]').count(), 1);
          }
          await page.screenshot({ path: join(artifacts, `badge-${result}-${width}-${theme}.png`) });
        } finally {
          await page.close();
        }
      });
    }
  }
}

for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(`activity directory navigation ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(origin + `fixture?real=1&theme=${theme}&locale=en-US`);
        await page.getByTestId("end-activity").click();
        await page.getByTestId("dismiss-activity").click();
        await page.locator('[data-status-capsule="activity"]').click();
        await page.screenshot({
          path: join(artifacts, `activity-directory-${width}-${theme}.png`),
        });
        for (const kind of ["subagent", "workflow"]) {
          if (kind === "workflow") await page.locator('[data-status-capsule="activity"]').click();
          await page.getByTestId(`activity-${kind}-directory`).click();
          assert.equal(
            await page.locator("output").textContent(),
            `${kind === "subagent" ? "agent" : "workflow"}-history:parent`,
          );
          await page
            .locator('[data-status-capsule-content="activity"]')
            .waitFor({ state: "hidden" });
        }
        await page.goto(origin + `fixture?real=1&theme=${theme}&locale=en-US&noDirectoryHost=1`);
        await page.locator('[data-status-capsule="activity"]').click();
        assert.equal(
          await page.locator('[data-testid^="activity-"][data-testid$="-directory"]').count(),
          0,
        );
      } finally {
        await page.close();
      }
    });
  }
}

for (const theme of ["light", "dark"])
  for (const width of [390, 1200])
    test(`current Git branch ${theme}/${width}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.goto(`${origin}fixture?real=1&theme=${theme}&locale=en-US`);
        await page.locator('[data-status-capsule="git"]').click();
        const row = page.getByTestId("status-git-current-branch");
        const review = page.getByTestId("status-git-view-all");
        assert.equal(await review.locator("span").last().textContent(), "2");
        assert.equal(
          await review.evaluate((node) =>
            Boolean(
              node.compareDocumentPosition(
                document.querySelector('[data-testid="status-git-current-branch"]'),
              ) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          ),
          true,
        );
        await page.locator('[data-status-capsule-content="git"]').evaluate(async (node) => {
          await Promise.all(
            node
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        assert.equal(
          await row.textContent(),
          "feature/current-branch-with-a-long-name-for-overflow",
        );
        assert.equal(await row.getAttribute("title"), await row.textContent());
        const geometry = await row.evaluate((node) => ({
          height: node.getBoundingClientRect().height,
          icon: node.querySelector("svg").getBoundingClientRect().width,
          overflow: node.scrollWidth > node.clientWidth,
        }));
        assert.ok(Math.abs(geometry.height - 32) < 1, JSON.stringify(geometry));
        assert.ok(Math.abs(geometry.icon - 16) < 1, JSON.stringify(geometry));
        assert.equal(geometry.overflow, false);
        const label = row.locator("span").last();
        const textStyle = await label.evaluate((node) => ({
          mask: getComputedStyle(node).maskImage,
          ellipsis: getComputedStyle(node).textOverflow,
        }));
        assert.notEqual(textStyle.mask, "none");
        assert.notEqual(textStyle.ellipsis, "ellipsis");
      } finally {
        await page.close();
      }
    });

for (const theme of ["light", "dark"])
  for (const width of [390, 1200])
    test(`Git scroll mask ${theme}/${width}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.goto(`${origin}fixture?real=1&manyFiles=1&theme=${theme}&locale=en-US`);
        await page.locator('[data-status-capsule="git"]').click();
        const viewport = page.getByTestId("status-git-files");
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="status-git-files"]')
              ?.getAttribute("data-scroll-mask") === "bottom",
        );
        const branch = page.getByTestId("status-git-current-branch");
        await page.locator('[data-status-capsule-content="git"]').evaluate(async (node) => {
          await Promise.all(
            node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})),
          );
        });
        const initial = await branch.boundingBox();
        const edge = await viewport.evaluate((node) => ({
          right: node.getBoundingClientRect().right,
          panelRight: node.closest("[data-status-capsule-content]").getBoundingClientRect().right,
          overscroll: getComputedStyle(node).overscrollBehaviorY,
        }));
        assert.ok(Math.abs(edge.right - edge.panelRight) < 2, JSON.stringify(edge));
        assert.equal(edge.overscroll, "contain");
        await viewport.evaluate((node) => {
          node.scrollTop = 100;
        });
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="status-git-files"]')
              ?.getAttribute("data-scroll-mask") === "both",
        );
        await viewport.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="status-git-files"]')
              ?.getAttribute("data-scroll-mask") === "top",
        );
        assert.deepEqual(await branch.boundingBox(), initial);
      } finally {
        await page.close();
      }
    });

for (const suffix of ["noDirectoryHost=1", "noHistory=1"]) {
  test(`archived Activity without usable directories disappears ${suffix}`, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}fixture?real=1&theme=dark&locale=en-US&endedOnly=1&${suffix}`);
      const capsule = page.locator('[data-status-capsule="activity"]');
      await capsule.click();
      assert.equal(await page.locator("[data-activity-result]").count(), 1);
      await page.getByTestId("dismiss-activity").click();
      await capsule.waitFor({ state: "hidden" });
      assert.equal(await page.locator('[data-status-capsule-content="activity"]').count(), 0);
    } finally {
      await page.close();
    }
  });
}

registerActivityHistoryCases({ getBrowser: () => browser, getOrigin: () => origin, artifacts });
