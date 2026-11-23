// CR-01/CR-02：真实 Git 控制器与受控服务响应下的弹窗生命周期回归。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = join(root, "composer-status-fixture.tsx");
const artifacts = join(root, "packages/desktop/.e2e-artifacts/git-action-lifecycle-browser");
const fixture = `
import { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { GitBranchActionsHost } from "@/GitBranchSwitcher.js";
import { ComposerStatusRow, ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { GitStatusRepositoryContext } from "@/hooks/useGitRepository.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";
const query = new URLSearchParams(location.search);
document.documentElement.className="theme-zai-"+query.get("theme")+" "+query.get("theme");
const summary={isGitAvailable:true,isRepository:true,branchName:"main",headRefType:"branch"};
let committed=false, releaseFailure;
const graphRequests=[];
window.graphRequests=graphRequests;
const graphResult=(name,hasMore=false)=>({commits:[{hash:name,parents:[],refs:[],subject:name,authorName:"Example",authoredAtMs:0}],hasMore});
const services={gitService:{
 getLocalBranches:async()=>({currentBranchName:"main",branches:[{name:"main",isCurrent:true},{name:"feature",isCurrent:false}]}),
 getChanges:async()=>[],getIdentity:async()=>null,
 switchBranch:async()=>{if(committed){await new Promise(r=>releaseFailure=r);throw new Error("E2E_SWITCH_FAILURE");}return {ok:false,branchName:"feature",action:"switch",summary,issues:[{code:"tracked-changes-would-be-overwritten",message:"blocked",paths:["file.txt"]}]};},
 stagePaths:async()=>{},commit:async()=>{committed=true;},
 createBranchAndSwitch:async()=>({ok:true,branchName:"new",summary,issues:[],didChange:true}),
 getCommitGraph:async(args)=>query.has("graphRace")?new Promise((resolve,reject)=>graphRequests.push({args,resolve:(name,more)=>resolve(graphResult(name,more)),reject})):graphResult("Retained commit")
}};
function Fixture(){
 const [hidden,setHidden]=useState(false),[dirty,setDirty]=useState(true),[session,setSession]=useState("a"),[cwd,setCwd]=useState("/example");
 const refresh=useCallback(()=>{if(committed)setDirty(false)},[]);
 return <ZCodeIntlProvider initialLocale={query.get("locale")??"en-US"}><ServiceProvider services={services}><TooltipProvider>
 <button data-testid="hide-error" onClick={()=>setHidden(true)}>Error</button>
 <button data-testid="hide-quota" onClick={()=>setHidden(true)}>Quota</button>
 <button data-testid="release" onClick={()=>releaseFailure?.()}>Release failure</button>
 <button data-testid="session" onClick={()=>{setSession(s=>s==="a"?"b":"a");setDirty(true)}}>Session</button>
 <button data-testid="cwd" onClick={()=>setCwd("/example/worktree")}>Cwd</button>
 <GitBranchActionsHost scopeKey={session} workspacePath={cwd} gitSummary={summary} dirtyFileCount={dirty?1:0} onRefreshGit={refresh}>
 <input data-testid="retained-editor" defaultValue="draft"/><GitStatusRepositoryContext.Provider value={{state:{datasets:{unstaged:{sections:dirty?[{changes:[{path:"file.txt",added:1,removed:0}]}]:[]},staged:{sections:[]}}}}}>
 {!hidden ? <div className="fixed bottom-4 left-4 right-4"><ComposerStatusRow><ConversationStatusPanel workspacePath="/example" gitSummary={summary} gitDirtyFileCount={dirty?1:0} onRefreshGit={refresh} /></ComposerStatusRow></div>:null}
 </GitStatusRepositoryContext.Provider></GitBranchActionsHost>
 </TooltipProvider></ServiceProvider></ZCodeIntlProvider>
}
createRoot(document.getElementById("root")).render(<Fixture/>);
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
    resolve: { alias: { "@": join(root, "packages/ui/src") } },
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

async function openBranch(page) {
  await page.locator('[data-status-capsule="git"]').click();
  await page.getByTestId("status-git-current-branch").getByRole("button").click();
  await page.locator("[cmdk-input]").waitFor();
}
for (const theme of ["light", "dark"])
  for (const width of [390, 1200]) {
    test(`graph survives status removal ${theme}/${width}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.goto(origin + `fixture?theme=${theme}`);
        await openBranch(page);
        await page.getByRole("button", { name: "Git Graph", exact: true }).click();
        await page.getByText("Retained commit", { exact: true }).waitFor();
        await page.locator('[data-status-capsule-content="git"]').waitFor({ state: "detached" });
        const row = page.getByText("Retained commit", { exact: true });
        await row.evaluate((node) => node.setAttribute("data-retained", "yes"));
        await page
          .getByTestId(width === 390 ? "hide-error" : "hide-quota")
          .evaluate((node) => node.click());
        assert.equal(await row.getAttribute("data-retained"), "yes");
        await page.screenshot({ path: join(artifacts, `graph-${theme}-${width}.png`) });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "detached" });
      } finally {
        await page.close();
      }
    });
    test(`create survives capsule close ${theme}/${width}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.goto(origin + `fixture?theme=${theme}`);
        await openBranch(page);
        await page.getByRole("button", { name: /Create.*branch/i }).click();
        await page.getByRole("dialog").waitFor();
        await page.locator('[data-status-capsule-content="git"]').waitFor({ state: "detached" });
        await page.locator("#git-branch-switcher-create-input").fill("new");
        await page.getByTestId("hide-error").evaluate((node) => node.click());
        assert.equal(await page.locator("#git-branch-switcher-create-input").inputValue(), "new");
        await page
          .getByTestId("retained-editor")
          .evaluate((node) => node.setAttribute("data-retained", "yes"));
        await page.getByTestId("session").evaluate((node) => node.click());
        assert.equal(
          await page.getByTestId("retained-editor").getAttribute("data-retained"),
          "yes",
        );
        await page.getByRole("dialog").waitFor({ state: "detached" });
      } finally {
        await page.close();
      }
    });
  }

for (const theme of ["light", "dark"]) {
  test(`partial commit failure survives clean files ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    try {
      await page.goto(origin + `fixture?theme=${theme}`);
      await openBranch(page);
      await page.getByRole("option", { name: "feature", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.locator('[data-status-capsule-content="git"]').waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await openBranch(page);
      await page.getByRole("option", { name: "feature", exact: true }).click();
      await page.getByRole("button", { name: "Commit and switch branch...", exact: true }).click();
      await page.getByRole("button", { name: "Commit and switch branch", exact: true }).click();
      await page.locator('[data-status-capsule="git"]').waitFor({ state: "detached" });
      assert.equal(await page.getByRole("dialog").count(), 1);
      await page.getByTestId("release").evaluate((node) => node.click());
      await page.getByText("Commit failed: E2E_SWITCH_FAILURE", { exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, `partial-${theme}.png`) });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
    } finally {
      await page.close();
    }
  });
}

for (const transition of ["session", "cwd"]) {
  test(`scope ${transition} keeps editor and rejects late switch failure`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    try {
      await page.goto(origin + "fixture?theme=light");
      await page.getByTestId("retained-editor").fill("keep my draft");
      await page
        .getByTestId("retained-editor")
        .evaluate((n) => n.setAttribute("data-retained", "yes"));
      await openBranch(page);
      await page.getByRole("option", { name: "feature", exact: true }).click();
      await page.getByRole("button", { name: "Commit and switch branch...", exact: true }).click();
      await page.getByRole("button", { name: "Commit and switch branch", exact: true }).click();
      await page.locator('[data-status-capsule="git"]').waitFor({ state: "detached" });
      await page.getByTestId(transition).evaluate((n) => n.click());
      await page.getByRole("dialog").waitFor({ state: "detached" });
      if (transition === "session") await page.getByTestId("session").evaluate((n) => n.click());
      await page.getByTestId("release").evaluate((n) => n.click());
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.equal(await page.getByTestId("retained-editor").getAttribute("data-retained"), "yes");
      assert.equal(await page.getByTestId("retained-editor").inputValue(), "keep my draft");
    } finally {
      await page.close();
    }
  });
}

for (const locale of ["zh-CN", "en-US"]) {
  test(`create submit is language independent ${locale}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    try {
      await page.goto(origin + `fixture?theme=light&locale=${locale}`);
      await openBranch(page);
      await page
        .getByRole("button", {
          name: locale === "zh-CN" ? "创建并检出新分支..." : "Create and switch to new branch...",
          exact: true,
        })
        .click();
      await page.locator("#git-branch-switcher-create-input").fill("new");
      const submit = page.locator(
        '[role="dialog"] form:has(#git-branch-switcher-create-input) button[type="submit"]',
      );
      assert.equal(
        await submit.textContent(),
        locale === "zh-CN" ? "创建并切换" : "Create and switch",
      );
      await submit.click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
    } finally {
      await page.close();
    }
  });
}

// 真实图谱组件使用可控服务 Promise，明确安排新响应先返回、旧响应后返回。
for (const scenario of ["initial", "initial-error", "refresh-error", "page", "cwd", "reopen"]) {
  test(`graph rejects stale ${scenario} response`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    const openGraph = async () => {
      await openBranch(page);
      await page.getByRole("button", { name: "Git Graph", exact: true }).click();
    };
    const waitRequests = (count) =>
      page.waitForFunction((n) => window.graphRequests.length === n, count);
    const release = (index, name, more = false) =>
      page.evaluate(({ index, name, more }) => window.graphRequests[index].resolve(name, more), {
        index,
        name,
        more,
      });
    try {
      await page.goto(origin + "fixture?theme=light&graphRace=1");
      await page
        .getByTestId("retained-editor")
        .evaluate((n) => n.setAttribute("data-retained", "yes"));
      await openGraph();
      await waitRequests(1);
      let stale = 0;
      if (scenario === "refresh-error" || scenario === "page") {
        await release(0, "Old initial", scenario === "page");
        await page.getByText("Old initial", { exact: true }).waitFor();
        if (scenario === "page") await page.getByRole("button", { name: /Load more/i }).click();
        else await page.getByRole("button", { name: /Refresh/i }).click();
        await waitRequests(2);
        stale = 1;
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      if (scenario !== "reopen") {
        await page.getByTestId(scenario === "cwd" ? "cwd" : "session").click();
        if (scenario !== "cwd") await page.getByTestId("session").click();
      }
      await openGraph();
      await waitRequests(stale + 2);
      await release(stale + 1, "Current history");
      const current = page.getByText("Current history", { exact: true });
      await current.waitFor();
      const before = await page.getByRole("dialog").innerHTML();
      if (scenario.endsWith("error")) {
        await page.evaluate(
          (i) => window.graphRequests[i].reject(new Error("STALE_GRAPH_ERROR")),
          stale,
        );
      } else await release(stale, "Stale history", true);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(await page.getByRole("dialog").innerHTML(), before);
      assert.equal(await page.getByText(/STALE_GRAPH_ERROR/).count(), 0);
      assert.equal(await page.getByRole("button", { name: /Load more/i }).count(), 0);
      assert.equal(await page.getByTestId("retained-editor").getAttribute("data-retained"), "yes");
      await page.screenshot({ path: join(artifacts, `graph-race-${scenario}.png`) });
    } finally {
      await page.close();
    }
  });
}
