import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import {
  createCredentialService,
  createSettingService,
  createProviderConfigRuntime,
  createProviderRuntimeFromConfigRuntime,
  createProviderProvisioningSource,
  createProviderProvisioningTarget,
  EmptyAccountProviderConfigSource,
  OAuthCredentialRepo,
} from "@zcode/services/node";

const base = process.env.ZCODE_DATA_BASE_DIR;
if (!base?.includes("oauth-provisioning-e2e-"))
  throw new Error("isolated provisioning HOME required");
const configDir = join(base, ".zcode", "v2");
const personalConfigFilePath = join(configDir, "provider_config.json");
const configRuntime = createProviderConfigRuntime({
  zcodeBuiltinFilePath: resolve("../../config/provider/zcode-builtin.json"),
  personalFilePath: personalConfigFilePath,
  watch: false,
  personalPollingIntervalMs: false,
});
const account = new EmptyAccountProviderConfigSource(configRuntime.configService);
const providerRuntime = createProviderRuntimeFromConfigRuntime({
  configRuntime,
  accountSource: account,
});
await providerRuntime.start();
const mutations: Array<{ operation: string; keys: readonly string[] }> = [];
const store = createCredentialService({ onDidMutate: (event) => mutations.push(event) });
const repo = new OAuthCredentialRepo(store);
let heldProfile: Awaited<ReturnType<OAuthCredentialRepo["loadSessionSnapshot"]>> | null = null;
const settings = createSettingService();
const source = createProviderProvisioningSource({
  personalRepository: configRuntime.personalRepository,
  settingService: settings,
  credentialFilePath: join(configDir, "credentials.json"),
  personalConfigFilePath,
});
const target = createProviderProvisioningTarget({
  providerRuntime,
  personalRepository: configRuntime.personalRepository,
  accountProviderSource: { refresh: () => account.read() },
  credentialService: store,
  settingService: settings,
  personalConfigFilePath,
  stateFilePath: join(configDir, "provisioning.json"),
});
const update = store.updateMany.bind(store);
let fault: "none" | "after-write" | "concurrent-login" = "none";
store.updateMany = async (changes, options) => {
  const result = await update(changes, options);
  if (!result || fault === "none") return result;
  const mode = fault;
  fault = "none";
  if (mode === "concurrent-login") {
    await update({
      ...changes,
      "oauth:session_revision": "e2e-concurrent-revision",
      zcodejwttoken: "e2e-concurrent-primary",
    });
  }
  throw new Error("e2e failure after atomic credential write");
};
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  try {
    let value: unknown;
    if (request.command === "seed") value = await update(request.values);
    else if (request.command === "read") value = await store.loadMany(request.keys);
    else if (request.command === "source") value = await source.read(request.syncId);
    else if (request.command === "apply") {
      mutations.splice(0);
      value = { ...(await target.apply(request.envelope)), mutations: [...mutations] };
    } else if (request.command === "hold-profile") heldProfile = await repo.loadSessionSnapshot();
    else if (request.command === "finish-profile") {
      if (!heldProfile) throw new Error("profile operation was not started");
      value = await repo.saveUserProfile(
        "zai_cn",
        {
          id: "e2e-primary-user",
          username: "late-profile",
          displayName: "Late profile",
          rawProfile: { user_id: "e2e-primary-user", name: "late-profile" },
        },
        heldProfile,
      );
      heldProfile = null;
    } else if (request.command === "availability") value = await repo.loadAccountAvailability();
    else if (request.command === "fault") fault = request.mode;
    else if (request.command === "close") {
      providerRuntime.dispose();
      process.stdout.write(`E2E_PROVISIONING ${JSON.stringify({ id: request.id, value: true })}\n`);
      process.exit(0);
    } else throw new Error("unknown provisioning fixture command");
    process.stdout.write(`E2E_PROVISIONING ${JSON.stringify({ id: request.id, value })}\n`);
  } catch (error) {
    process.stdout.write(
      `E2E_PROVISIONING ${JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : "fixture failed" })}\n`,
    );
  }
}
