import { readFile } from "node:fs/promises";
import { platform, userInfo } from "node:os";
import { resolve } from "node:path";
import { createCredentialService, setDataBaseDir } from "@zcode/services/node";
import { createCredentialCipherProvider } from "../../../../services/src/credential/providers/credentialCipherProvider.js";
import { getE2EAppDataPaths } from "#e2e/helpers/desktop-app";

const IMPORT_KEYS = [
  "oauth:bigmodel:access_token",
  "oauth:bigmodel:refresh_token",
  "oauth:bigmodel:user_info",
  "oauth:active_provider",
  "zcodejwttoken",
];

/**
 * 从本机正式凭据库解密 BigModel 登录材料与 Team 项目 key（内存），经正式 Credential Service 用隔离 profile
 * 的 cipher 重新保存。默认 cipher 由 platform/homedir/username 派生，两侧显式给出 secret，不猜测 worker 的 HOME。
 *
 * 同时带回本机 setting.json 的 bigmodel 连接选择。0911 修复：裸 `{ kind: "team-coding-plan" }`
 * 不满足 appSettingsSchema（productId/organizationId/projectId 必填），会让 main 侧
 * readStartupSettings 校验失败整份回退默认设置——startupWorkspace 走首启分支落在
 * conversation 工作区，且 providerFamilyDomain 也丢失。产品 UI（ModelProviderSection）
 * 只在三字段齐全时才写该条目，因此这里必须原样拷贝本机真实选择。
 */
export async function importLiveBigModelCredentials(caseMarker: string): Promise<{
  imported: string[];
  refreshTokenPresent: boolean;
  teamKeyPresent: boolean;
  teamSelection: {
    kind: "team-coding-plan";
    productId: string;
    organizationId: string;
    projectId: string;
  };
}> {
  const sourceHome = process.env.R3_LIVE_SOURCE_HOME?.trim();
  if (!sourceHome) throw new Error(`${caseMarker}: 需设置 R3_LIVE_SOURCE_HOME（本机真实 HOME）`);
  const username = userInfo().username;
  const sourceCipher = createCredentialCipherProvider({
    env: {
      ZCODE_CREDENTIAL_SECRET: `zcode-credential-fallback:${platform()}:${sourceHome}:${username}`,
    },
  });
  const original = JSON.parse(
    await readFile(resolve(sourceHome, ".zcode", "v2", "credentials.json"), "utf8"),
  ) as Record<string, string>;
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(original)) {
    if (
      IMPORT_KEYS.includes(key) ||
      (key.startsWith("account-provider:coding-plan:account:bigmodel-team-coding-plan:") &&
        key.endsWith(":api-key"))
    ) {
      values.set(key, sourceCipher.decrypt(value));
    }
  }
  if (!values.has("oauth:bigmodel:access_token")) {
    throw new Error(`${caseMarker}: 本机没有 BigModel 登录材料`);
  }
  // §49 实锤：本机凭据库可能没有 oauth:bigmodel:refresh_token（产品流是否落盘该 key 未知）。
  // access_token 是 opaque token 无法本地判过期——一旦失效且无 refresh_token 续期，
  // reloadSession 后 UI 会停在 BigModel 登录引导页（SessionPane 不渲染 → workspace 菜单
  // 不可达 → connectSSHWorkspace 超时）。此处只记 facts 线索，不硬性阻断。
  if (!values.has("oauth:bigmodel:refresh_token")) {
    console.warn(
      `[${caseMarker}] 本机凭据缺少 oauth:bigmodel:refresh_token——若 UI 停在登录引导页，需在本机 app 重新登录 BigModel 刷新材料`,
    );
  }
  const paths = getE2EAppDataPaths();
  // services 的数据根是 HOME 级目录（其下 .zcode/v2），与 desktop-app helper 的 credentialsFile 同一文件。
  setDataBaseDir(paths.homeDir);
  const targetCipher = createCredentialCipherProvider({
    env: {
      ZCODE_CREDENTIAL_SECRET:
        process.env.ZCODE_CREDENTIAL_SECRET ||
        `zcode-credential-fallback:${platform()}:${paths.homeDir}:${username}`,
    },
  });
  const service = createCredentialService({ cipherProvider: targetCipher });
  for (const [key, value] of values) await service.save(key, value);
  const written = JSON.parse(await readFile(paths.credentialsFile, "utf8")) as Record<
    string,
    string
  >;
  for (const key of values.keys()) {
    if (!(key in written)) throw new Error(`${caseMarker}: 凭据未写入隔离 profile: ${key}`);
  }
  const sourceSettings = JSON.parse(
    await readFile(resolve(sourceHome, ".zcode", "v2", "setting.json"), "utf8"),
  ) as Record<string, unknown>;
  const sourceSelection = (
    sourceSettings.providerFamilyConnectionSelections as Record<string, unknown> | undefined
  )?.bigmodel as
    | { kind?: string; productId?: string; organizationId?: string; projectId?: string }
    | undefined;
  if (
    sourceSelection?.kind !== "team-coding-plan" ||
    !sourceSelection.productId ||
    !sourceSelection.organizationId ||
    !sourceSelection.projectId
  ) {
    throw new Error(
      `${caseMarker}: 本机 setting.json 没有 bigmodel team-coding-plan 连接选择（productId/organizationId/projectId 齐全），无法构造合法窄设置`,
    );
  }
  return {
    imported: [...values.keys()],
    refreshTokenPresent: values.has("oauth:bigmodel:refresh_token"),
    teamKeyPresent: [...values.keys()].some((key) => key.includes("bigmodel-team-coding-plan")),
    teamSelection: {
      kind: "team-coding-plan",
      productId: sourceSelection.productId,
      organizationId: sourceSelection.organizationId,
      projectId: sourceSelection.projectId,
    },
  };
}
