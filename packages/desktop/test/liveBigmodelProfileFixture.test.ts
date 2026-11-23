import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { getDataBaseDir, setDataBaseDir } from "@zcode/services/node";
import { createLegacyCredentialCipher } from "@zcode/shared/credential-security";

const fixture = vi.hoisted(() => ({ homeDir: "", credentialsFile: "" }));
vi.mock("#e2e/helpers/desktop-app", () => ({ getE2EAppDataPaths: () => fixture }));

import { importLiveBigModelCredentials } from "#e2e/helpers/live-bigmodel-profile";

it("imports OAuth without reading an unrelated cached Team key, and re-encrypts for the target profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-profile-fixture-"));
  const sourceHome = join(root, "source");
  fixture.homeDir = join(root, "target");
  fixture.credentialsFile = join(fixture.homeDir, ".zcode/v2/credentials.json");
  const sourceDirectory = join(sourceHome, ".zcode/v2");
  const previousHome = process.env.R3_LIVE_SOURCE_HOME;
  const previousSecret = process.env.ZCODE_CREDENTIAL_SECRET;
  const previousDataBaseDir = getDataBaseDir();
  process.env.R3_LIVE_SOURCE_HOME = sourceHome;
  process.env.ZCODE_CREDENTIAL_SECRET = "live-profile-target-test-secret";
  const sourceCipher = createLegacyCredentialCipher({
    ZCODE_CREDENTIAL_SECRET: `zcode-credential-fallback:${platform()}:${sourceHome}:${userInfo().username}`,
  });
  const credentials = {
    "oauth:bigmodel:access_token": "test-access",
    "oauth:bigmodel:refresh_token": "test-refresh",
    "oauth:bigmodel:user_info": JSON.stringify({ id: "fixture-user" }),
    "oauth:active_provider": "bigmodel",
    zcodejwttoken: "test-jwt",
  };
  const staleKey = "account-provider:coding-plan:account:bigmodel-team-coding-plan:fixture:api-key";
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      join(sourceDirectory, "credentials.json"),
      JSON.stringify({
        ...Object.fromEntries(
          Object.entries(credentials).map(([key, value]) => [key, sourceCipher.encrypt(value)]),
        ),
        [staleKey]: "enc:v2:unrelated-old-cache",
      }),
    );
    await writeFile(
      join(sourceDirectory, "setting.json"),
      JSON.stringify({
        providerFamilyConnectionSelections: {
          bigmodel: {
            kind: "team-coding-plan",
            productId: "test-product",
            organizationId: "test-org",
            projectId: "test-project",
          },
        },
      }),
    );
    const result = await importLiveBigModelCredentials("E2E_LIVE_PROFILE");
    expect(result.imported.sort()).toEqual(Object.keys(credentials).sort());
    expect(result.refreshTokenPresent).toBe(true);
    const written = JSON.parse(await readFile(fixture.credentialsFile, "utf8"));
    expect(written).not.toHaveProperty(staleKey);
    const targetCipher = createLegacyCredentialCipher();
    for (const [key, value] of Object.entries(credentials)) {
      expect(targetCipher.decrypt(written[key])).toBe(value);
    }
  } finally {
    setDataBaseDir(previousDataBaseDir);
    if (previousHome === undefined) delete process.env.R3_LIVE_SOURCE_HOME;
    else process.env.R3_LIVE_SOURCE_HOME = previousHome;
    if (previousSecret === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET;
    else process.env.ZCODE_CREDENTIAL_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});
