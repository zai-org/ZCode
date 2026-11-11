import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";

describe("System credential owner", () => {
  it("delegates repeated Host reads to Main without accessing the system store from Host", async function () {
    this.timeout(90000);
    try {
      await browser.waitUntil(
        async () =>
          browser.execute(() =>
            Boolean(
              document.querySelector(
                '[data-testid="login-trigger"], [data-testid="onboarding-page"], [data-testid="oauth-login-button"]',
              ),
            ),
          ),
        { timeout: 60000 },
      );
      const paths = getE2EAppDataPaths();
      const record = JSON.parse(await readFile(paths.credentialsFile, "utf8"));
      await writeFile(
        paths.credentialsFile,
        JSON.stringify({ ...record, "bot:e2e:owner": "synthetic-owner-value" }),
      );
      const results = await browser.execute(async () => {
        const element = document.querySelector(
          '[data-testid="login-trigger"], [data-testid="onboarding-page"], [data-testid="oauth-login-button"]',
        )!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.credentialService ? value : fiber.memoizedProps?.services;
          if (services?.credentialService) {
            return Promise.all(
              Array.from({ length: 12 }, () => services.credentialService.load("bot:e2e:owner")),
            );
          }
          fiber = fiber.return;
        }
        throw new Error("Credential service not found");
      });
      expect(results).toEqual(Array(12).fill("synthetic-owner-value"));
      // 大 profile 加密后会膨胀；回复必须可接收，超限失败也不能卡住后续读写。
      const boundary = await browser.execute(async () => {
        const element = document.querySelector(
          '[data-testid="login-trigger"], [data-testid="onboarding-page"], [data-testid="oauth-login-button"]',
        )!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.credentialService ? value : fiber.memoizedProps?.services;
          if (services?.credentialService) {
            const large = "x".repeat(800000);
            await services.credentialService.save("bot:e2e:large", large);
            const roundtrip = await services.credentialService.load("bot:e2e:large");
            let rejected = false;
            try {
              await services.credentialService.save("bot:e2e:too-large", "界".repeat(400000));
            } catch {
              rejected = true;
            }
            await services.credentialService.save("bot:e2e:after-limit", "still-available");
            return {
              roundtrip: roundtrip === large,
              rejected,
              later: await services.credentialService.load("bot:e2e:after-limit"),
            };
          }
          fiber = fiber.return;
        }
        throw new Error("Credential service not found");
      });
      expect(boundary).toEqual({ roundtrip: true, rejected: true, later: "still-available" });
      const saved = JSON.parse(await readFile(paths.credentialsFile, "utf8"));
      expect(saved["bot:e2e:owner"]).toMatch(/^enc:v2:os:/);
      const observations = (await readFile(join(paths.homeDir, "credential-owner.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; role: string; pid: number });
      expect(observations.some((item) => item.event === "loaded" && item.role === "utility")).toBe(
        true,
      );
      const reads = observations.filter((item) => item.event === "get");
      expect(reads).toHaveLength(1);
      expect(reads[0]?.role).toBe("browser");
      expect(observations.some((item) => item.event === "set")).toBe(false);
    } finally {
      await clearAppData();
    }
  });
});
