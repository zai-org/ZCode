import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

export const PLUGIN_CDN_ZIP_MARKETPLACE_SPEC = "plugin-cdn-zip-marketplace-install.test.ts";
export const PLUGIN_STORE_AUTO_REFRESH_THROTTLED_SPEC =
  "plugin-store-auto-refresh-throttled.test.ts";
export const PLUGIN_STORE_AUTO_REFRESH_ON_ENTER_SPEC = "plugin-store-auto-refresh-on-enter.test.ts";
// 固定未来时间阻止正式离线用例启动时自动刷新真实官方 CDN。
export const PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED = "2099-01-01T00:00:00.000Z";
// 远古时间让「进入商店页即刷新官方市场」用例必然落在节流窗口之外（且 pluginCount>0，
// 确保走的是节流路径而不是「从未加载过」路径）。
export const PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED = "2000-01-01T00:00:00.000Z";
export const PLUGIN_CDN_ZIP_MARKETPLACE_ID = "zcode-plugins-official";
export const PLUGIN_CDN_ZIP_MARKETPLACE_NAME = "ZCode Official Plugins";
export const PLUGIN_CDN_ZIP_NAME = "e2e-cdn-zip-plugin";
export const PLUGIN_CDN_ZIP_ID = `${PLUGIN_CDN_ZIP_NAME}@${PLUGIN_CDN_ZIP_MARKETPLACE_ID}`;
export const PLUGIN_CDN_ZIP_VERSION = "7.8.9";
export const PLUGIN_CDN_ZIP_ARCHIVE_PATH = "/e2e-cdn-zip-plugin.zip";

export interface PluginCdnZipFixtureServer {
  baseUrl: string;
  server: Server;
  sha256: string;
  oversizedLocales: boolean;
}

const PLUGIN_CDN_ZIP_FIXTURE_SPECS = [
  PLUGIN_CDN_ZIP_MARKETPLACE_SPEC,
  "agent-plugin-discovery.test.ts",
  PLUGIN_STORE_AUTO_REFRESH_THROTTLED_SPEC,
  PLUGIN_STORE_AUTO_REFRESH_ON_ENTER_SPEC,
];

function matchesSpec(specName: string, specs: string[]): boolean {
  return process.argv.concat(specs).some((spec) => spec.includes(specName));
}

export function shouldUsePluginCdnZipMarketplaceFixture(specs: string[] = []): boolean {
  return PLUGIN_CDN_ZIP_FIXTURE_SPECS.some((specName) => matchesSpec(specName, specs));
}

/**
 * 按 spec 决定 seed 进 known_marketplaces.json 的官方市场 lastUpdated：
 * - 节流跳过用例：启动前 1 分钟，进入商店页应命中 10 分钟窗口而不刷新（离线可跑）；
 * - 进入即刷新用例：远古时间，进入商店页必须真打 CDN 刷新；
 * - 其余离线用例：未来时间，阻止任何自动访问公网。
 */
export function resolvePluginCdnZipMarketplaceLastUpdated(specs: string[] = []): string {
  if (matchesSpec(PLUGIN_STORE_AUTO_REFRESH_THROTTLED_SPEC, specs)) {
    return new Date(Date.now() - 60_000).toISOString();
  }
  if (matchesSpec(PLUGIN_STORE_AUTO_REFRESH_ON_ENTER_SPEC, specs)) {
    return PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED;
  }
  return PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED;
}

export async function startPluginCdnZipFixtureServer(
  specs: string[] = [],
): Promise<PluginCdnZipFixtureServer> {
  const oversizedLocales = matchesSpec("agent-plugin-discovery.test.ts", specs);
  const zipBuffer = createPluginCdnZipArchive();
  const sha256 = hashBytes(zipBuffer);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/marketplace.json") {
      const address = server.address() as AddressInfo;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          createPluginCdnZipManifest(`http://127.0.0.1:${address.port}`, sha256, oversizedLocales),
        ),
      );
      return;
    }
    if (pathname !== PLUGIN_CDN_ZIP_ARCHIVE_PATH) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-length": String(zipBuffer.byteLength),
      "content-type": "application/zip",
    });
    response.end(zipBuffer);
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Plugin CDN zip fixture server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    server,
    sha256,
    oversizedLocales,
  };
}

export async function stopPluginCdnZipFixtureServer(
  fixture: PluginCdnZipFixtureServer | undefined,
): Promise<void> {
  if (!fixture?.server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    fixture.server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export function seedPluginCdnZipMarketplaceFixture(input: {
  e2eHomeDir: string;
  server: PluginCdnZipFixtureServer;
  lastUpdated?: string;
  localCatalog?: boolean;
}): void {
  const pluginStorageRoot = join(input.e2eHomeDir, ".zcode", "cli", "plugins");
  const marketplaceSourceRoot = join(
    input.e2eHomeDir,
    "fixtures",
    "plugin-cdn-zip-marketplace-source",
  );
  const manifest = createPluginCdnZipManifest(
    input.server.baseUrl,
    input.server.sha256,
    input.server.oversizedLocales,
  );
  const knownMarketplaces = {
    version: 1,
    marketplaces: [
      {
        id: PLUGIN_CDN_ZIP_MARKETPLACE_ID,
        source: {
          source: "url",
          url: input.localCatalog
            ? `${input.server.baseUrl}/marketplace.json`
            : "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
        },
        name: PLUGIN_CDN_ZIP_MARKETPLACE_NAME,
        description: manifest.description,
        addedAt: "2026-01-01T00:00:00.000Z",
        lastUpdated: input.lastUpdated ?? PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED,
        pluginCount: manifest.plugins.length,
      },
      // 商店页已不再自动拉取 claude-plugins-official；这里仍预置成「已加载」，一是与其它离线
      // fixture 惯例一致，二是让 PLM-LC-018 能断言进入商店页后该记录没有任何刷新/失败痕迹。
      {
        id: "claude-plugins-official",
        source: { source: "github", repo: "anthropics/claude-plugins-official" },
        name: "claude-plugins-official",
        description: "Deterministic offline Claude marketplace marker",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastUpdated: PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED,
        pluginCount: 1,
      },
    ],
  };

  writeJsonFileSync(join(marketplaceSourceRoot, ".claude-plugin", "marketplace.json"), manifest);
  // 官方市场由 bundled/CDN 两个分片重建。把确定性条目写入 CDN 分片，应用启动 seed
  // bundled 分片时才不会覆盖本地 fixture；lastUpdated 则阻止 UI 自动访问公网。
  writeJsonFileSync(
    join(pluginStorageRoot, "marketplaces", PLUGIN_CDN_ZIP_MARKETPLACE_ID, "cdn-marketplace.json"),
    manifest,
  );
  writeJsonFileSync(
    join(pluginStorageRoot, "marketplaces", PLUGIN_CDN_ZIP_MARKETPLACE_ID, "marketplace.json"),
    manifest,
  );
  writeJsonFileSync(join(pluginStorageRoot, "known_marketplaces.json"), knownMarketplaces);
}

function createPluginCdnZipArchive(): Buffer {
  return createStoredZip([
    {
      path: `${PLUGIN_CDN_ZIP_NAME}-${PLUGIN_CDN_ZIP_VERSION}/.claude-plugin/plugin.json`,
      content: JSON.stringify({
        commands: "commands",
        description: "E2E CDN zip plugin",
        name: PLUGIN_CDN_ZIP_NAME,
        skills: "skills",
        version: PLUGIN_CDN_ZIP_VERSION,
      }),
    },
    {
      path: `${PLUGIN_CDN_ZIP_NAME}-${PLUGIN_CDN_ZIP_VERSION}/skills/zip-skill/SKILL.md`,
      content: [
        "---",
        "name: zip-skill",
        "description: E2E skill loaded from a CDN zip plugin",
        "---",
        "",
        "# zip-skill",
        "",
        "Use this skill to prove CDN zip plugin discovery.",
      ].join("\n"),
    },
    {
      path: `${PLUGIN_CDN_ZIP_NAME}-${PLUGIN_CDN_ZIP_VERSION}/commands/zip-command.md`,
      content: [
        "---",
        "description: E2E command loaded from a CDN zip plugin",
        "allowed-tools: Bash",
        "---",
        "",
        "Run a zip fixture command with $ARGUMENTS.",
      ].join("\n"),
    },
  ]);
}

function createStoredZip(entries: Array<{ content?: string; path: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.content ?? "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJsonFileSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function createPluginCdnZipManifest(baseUrl: string, sha256: string, oversizedLocales: boolean) {
  // 仅发现用例注入超大目录；界面语言放末尾，避免单纯截取前 N 项也能通过。
  const extraLocales = oversizedLocales
    ? Object.fromEntries(
        Array.from({ length: 5_000 }, (_, index) => [
          `x-${index}`,
          index === 0 ? '"\n🚀'.repeat(2_000) : "Unused fixture translation",
        ]),
      )
    : {};
  const localizedListing = oversizedLocales
    ? {
        displayName_i18n: {
          ...extraLocales,
          "zh-CN": "ZIP 归档助手",
          "en-US": "ZIP Archive Helper",
          "ja-JP": "ZIP ヘルパー",
          "ru-RU": "ZIP помощник",
          "ko-KR": "ZIP 도우미",
        },
        description_i18n: {
          ...extraLocales,
          "zh-CN": "用于验证大翻译表的本地插件",
          "en-US": "Local plugin with a large translation catalog",
          "ja-JP": "ローカルプラグイン",
          "ru-RU": "Локальный плагин",
          "ko-KR": "로컬 플러그인",
        },
      }
    : {};
  return {
    name: PLUGIN_CDN_ZIP_MARKETPLACE_ID,
    description: "E2E marketplace seeded before desktop startup for CDN zip install.",
    plugins: [
      {
        name: PLUGIN_CDN_ZIP_NAME,
        version: PLUGIN_CDN_ZIP_VERSION,
        description: "E2E CDN zip plugin",
        ...localizedListing,
        commands: ["zip-command"],
        skills: ["zip-skill"],
        source: {
          source: "url",
          type: "zip",
          url: `${baseUrl}${PLUGIN_CDN_ZIP_ARCHIVE_PATH}`,
          sha256,
        },
      },
    ],
  };
}
