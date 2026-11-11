import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "oauth-attribution-recovery-"));
process.env.ZCODE_DATA_BASE_DIR = home;
const { createCredentialService, createOAuthService } = await import("@zcode/services/node");
const file = join(home, ".zcode/v2/credentials.json");
await mkdir(join(home, ".zcode/v2"), { recursive: true });
const credential = createCredentialService({
  cipherProvider: { encrypt: (value) => value, decrypt: (value) => value },
});
const oauth = createOAuthService(credential, {
  apiClient: {
    request: async () => {
      throw new Error("Attribution fixture must not request a network token");
    },
  },
  captureCredentialGuard: () => credential.captureRecoveryGuard(),
});
const results = [];
try {
  for (const provider of ["zai", "bigmodel"] as const) {
    await writeFile(file, "{}");
    const flow = await oauth.startOAuth(provider);
    await writeFile(file, '{"unfinished":');
    const inspection = await credential.inspectStore();
    assert.equal(inspection.status, "corrupt");
    if (inspection.status !== "corrupt") throw new Error("Expected synthetic corrupt store");
    assert.equal((await credential.recoverStore(inspection.fingerprint)).status, "recovered");
    const empty = await readFile(file, "utf8");
    const generation = await readFile(`${file}.recovery-generation`, "utf8");
    const callback = (state: string) =>
      `zcode://oauth/callback?state=${state}&utm_source=synthetic-${provider}`;
    await assert.rejects(oauth.handleCallback(callback(flow.state)), {
      code: "ZCODE_CREDENTIAL_STORE_CHANGED",
    });
    assert.equal(await readFile(file, "utf8"), empty);
    assert.equal(await readFile(`${file}.recovery-generation`, "utf8"), generation);
    assert.equal(await credential.load("oauth:login_attribution"), null);
    const fresh = await oauth.startOAuth(provider);
    assert.equal((await oauth.handleCallback(callback(fresh.state)))?.kind, "attribution");
    assert.deepEqual(JSON.parse((await credential.load("oauth:login_attribution"))!), {
      utm_source: `synthetic-${provider}`,
    });
    await assert.rejects(oauth.handleCallback(callback(fresh.state)), /归因回调已处理/);
    await oauth.cancelPending(provider);
    results.push({
      provider,
      staleAttributionRejected: true,
      emptyStorePreserved: true,
      freshAttributionPreserved: true,
      duplicateRejected: true,
    });
  }
  const result = { results, realUserCredentials: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await oauth.cancelPending();
  await rm(home, { recursive: true, force: true });
}
