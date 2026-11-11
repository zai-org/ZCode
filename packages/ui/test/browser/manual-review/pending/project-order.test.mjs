import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/project-order.fixture.tsx";
const key = (id, hostId = "local") => JSON.stringify([hostId, id]);
const project = (id, hostId = "local") => ({
  id,
  hostId,
  name: id,
  position: 0,
  roots: [],
  pinned: false,
  deleted: false,
  nameOverridden: true,
  createdAt: 1,
  updatedAt: 1,
});
let server, browser, origin;
before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      {
        name: "project-order-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/fixture") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 19381,
      watch: { ignored: ["**/dist/**", "**/out/**", "**/.e2e*/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(saved, tree, mobile = false) {
  const context = await browser.newContext({
    viewport: { width: mobile ? 390 : 1200, height: 844 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  await context.addInitScript(
    ({ saved, tree }) => {
      if (!sessionStorage.getItem("project-order-fixture-tree")) {
        sessionStorage.setItem("project-order-fixture-tree", JSON.stringify(tree));
        localStorage.setItem(
          "zcode-project-sidebar-preferences",
          JSON.stringify({ view: "projects", order: saved }),
        );
      }
    },
    { saved, tree },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(`${origin}fixture`);
  await page.waitForFunction(() => Boolean(window.projectOrderFixture));
  return page;
}
async function expectOrder(page, expected) {
  await page.waitForFunction(
    (expected) =>
      JSON.stringify(
        [...document.querySelectorAll("[data-project-key]")].map((node) => node.dataset.projectKey),
      ) === JSON.stringify(expected),
    expected,
  );
  assert.deepEqual(
    await page
      .locator("[data-project-key]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.projectKey)),
    expected,
  );
}
async function publish(page, projects, availability) {
  await page.evaluate((tree) => window.projectOrderFixture.publish(tree), {
    projects,
    availability,
  });
}

for (const mobile of [false, true]) {
  test(`PRO02: new projects precede saved manual order, duplicate refresh and reload (${mobile ? "mobile" : "desktop"})`, async () => {
    const page = await open(
      [key("A"), key("B")],
      { projects: [project("B"), project("A")] },
      mobile,
    );
    try {
      await expectOrder(page, [key("A"), key("B")]);
      const current = [project("D"), project("C"), project("B"), project("A")];
      await publish(page, current);
      await expectOrder(page, [key("D"), key("C"), key("A"), key("B")]);
      await page.locator("li").filter({ hasText: "B" }).getByRole("button").click();
      const manual = [key("B"), key("D"), key("C"), key("A")];
      await expectOrder(page, manual);
      await publish(page, current);
      await expectOrder(page, manual);
      await page.reload();
      await expectOrder(page, manual);
    } finally {
      await page.context().close();
    }
  });
}

test("PRO02: known offline projects and upgraded identities retain their saved slot", async () => {
  const remote = project("remote-project", "remote:server:example");
  const remoteKey = key(remote.id, remote.hostId);
  const saved = [key("A"), remoteKey, key("B")];
  const page = await open(saved, { projects: [project("B"), project("A")] });
  try {
    await expectOrder(page, [key("A"), key("B")]);
    await publish(page, [project("B"), remote, project("A")]);
    await expectOrder(page, saved);
  } finally {
    await page.context().close();
  }
  const upgraded = await open([key("A"), key("legacy:entry"), key("B")], {
    projects: [project("B"), remote, project("A")],
    availability: [[remoteKey, { online: true, upgradeEntryId: "entry" }]],
  });
  try {
    await expectOrder(upgraded, saved);
  } finally {
    await upgraded.context().close();
  }
});
