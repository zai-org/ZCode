import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeMarketplacePlugin } from "../src/plugins/index.js";
import {
  loadMarketplaceManifestSync,
  normalizeAuthorValue,
  parseEntryExtensionSummary,
  parseEntryStoreListing,
} from "../src/plugins/marketplace.js";

// 商店信息（Store Listing）与 featured 策展名单的解析测试：
// 输入形状对齐官方 CDN 目录 schema（description_i18n / displayName_i18n / author 对象等），
// 见 docs/plugin-marketplace-ui-ux.md「数据模型与 schema 扩展」。
describe("marketplace store listing", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  async function makeStorageRoot(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    cleanups.push(dir);
    return dir;
  }

  it("parses listing fields and top-level featured from a CDN-shaped manifest", async () => {
    const storageRoot = await makeStorageRoot("zcode-marketplace-listing-");
    const marketplaceDir = join(storageRoot, "marketplaces", "zcode-plugins-official");
    await mkdir(marketplaceDir, { recursive: true });
    await writeFile(
      join(marketplaceDir, "marketplace.json"),
      JSON.stringify({
        name: "zcode-plugins-official",
        description: "Official ZCode plugins marketplace",
        featured: ["example-plugin", " ", 42, "another"],
        plugins: [
          {
            name: "example-plugin",
            description: "A minimal template plugin",
            description_i18n: { "zh-CN": "一个最小模板插件" },
            displayName: "Example Plugin",
            displayName_i18n: { "zh-CN": "示例插件" },
            version: "0.1.1",
            author: { name: "Z.ai", url: "https://z.ai" },
            category: "template",
            icon: "https://cdn-zcode.z.ai/icons/example.png",
            homepage: "https://z.ai/plugins/example",
            privacyPolicy: "https://z.ai/privacy",
            termsOfService: "https://z.ai/terms",
            heroImage: "https://cdn-zcode.z.ai/hero/example.png",
            examplePrompts: ["Try the example"],
            examplePrompts_i18n: { "zh-CN": ["试试这个示例"] },
            requiresPaidPlan: true,
            source: {
              source: "url",
              type: "zip",
              url: "https://cdn.example/x.zip",
              sha256: "a".repeat(64),
            },
          },
          {
            // 无任何商店字段的条目：listing 必须缺省而不是空对象。
            name: "bare-plugin",
            source: { source: "github", repo: "acme/bare-plugin" },
          },
          {
            // requiresPaidPlan 只认布尔 true：歧义写法按无需套餐处理。
            name: "ambiguous-plan-plugin",
            requiresPaidPlan: "true",
            source: { source: "github", repo: "acme/ambiguous" },
          },
        ],
      }),
    );

    const manifest = loadMarketplaceManifestSync(storageRoot, "zcode-plugins-official");
    expect(manifest).not.toBeNull();
    // featured 只保留非空字符串，保持顺序。
    expect(manifest?.featured).toEqual(["example-plugin", "another"]);

    const example = manifest?.plugins.find((entry) => entry.name === "example-plugin");
    expect(example?.listing).toEqual({
      displayName: "Example Plugin",
      displayNameI18n: { "zh-CN": "示例插件" },
      descriptionI18n: { "zh-CN": "一个最小模板插件" },
      icon: "https://cdn-zcode.z.ai/icons/example.png",
      category: "template",
      author: "Z.ai",
      authorUrl: "https://z.ai",
      homepage: "https://z.ai/plugins/example",
      privacyPolicy: "https://z.ai/privacy",
      termsOfService: "https://z.ai/terms",
      heroImage: "https://cdn-zcode.z.ai/hero/example.png",
      examplePrompts: ["Try the example"],
      examplePromptsI18n: { "zh-CN": ["试试这个示例"] },
      requiresPaidPlan: true,
    });

    const bare = manifest?.plugins.find((entry) => entry.name === "bare-plugin");
    expect(bare?.listing).toBeUndefined();

    const ambiguous = manifest?.plugins.find((entry) => entry.name === "ambiguous-plan-plugin");
    expect(ambiguous?.listing).toBeUndefined();
  });

  it("normalizes author from string and object forms", () => {
    expect(normalizeAuthorValue("Acme")).toEqual({ name: "Acme" });
    expect(normalizeAuthorValue({ name: "Z.ai", url: "https://z.ai" })).toEqual({
      name: "Z.ai",
      url: "https://z.ai",
    });
    expect(normalizeAuthorValue("   ")).toBeUndefined();
    expect(normalizeAuthorValue(42)).toBeUndefined();
    expect(parseEntryStoreListing({ name: "x", author: "Acme" })).toEqual({ author: "Acme" });
  });

  it("preserves publisher classification independently of usage category", () => {
    expect(parseEntryStoreListing({ publisherType: "community", category: "productivity" }))
      .toEqual({ publisherType: "community", category: "productivity" });
    expect(parseEntryStoreListing({ publisherType: "official" }))
      .toEqual({ publisherType: "official" });
    expect(parseEntryStoreListing({ publisherType: "personal" })).toBeUndefined();
    expect(parseEntryStoreListing({ publisherType: true })).toBeUndefined();
  });

  // 扩展摘要（docs/plugins/plugin-publishing.md §4.2–4.3）：CLI 只透传，只留 engines.zcode 与字符串 grants，
  // 不检查范围格式；它不进 Store Listing，由 overview 按请求参数决定带不带。
  it("parses the catalog extension summary and keeps only the two known keys", () => {
    expect(
      parseEntryExtensionSummary({
        extensionSummary: {
          engines: { zcode: "^1.4.0", node: ">=20" },
          grants: ["sessions.fullAccess", 42, "notifications"],
          main: "./dist/extension.js",
        },
      }),
    ).toEqual({ engines: { zcode: "^1.4.0" }, grants: ["sessions.fullAccess", "notifications"] });
    // 范围格式不检查：App 不认识的写法由 App 判不兼容。
    expect(
      parseEntryExtensionSummary({ extensionSummary: { engines: { zcode: ">=1.4.0 <3" } } }),
    ).toEqual({ engines: { zcode: ">=1.4.0 <3" }, grants: [] });
    expect(parseEntryExtensionSummary({})).toBeUndefined();
    expect(parseEntryExtensionSummary({ extensionSummary: "^1.4.0" })).toBeUndefined();
    expect(parseEntryExtensionSummary({ extensionSummary: { grants: [] } })).toBeUndefined();
    expect(
      parseEntryExtensionSummary({ extensionSummary: { engines: { zcode: "  " } } }),
    ).toBeUndefined();
    expect(
      parseEntryExtensionSummary({ extensionSummary: { engines: { zcode: 1 } } }),
    ).toBeUndefined();
    expect(
      parseEntryStoreListing({
        extensionSummary: { engines: { zcode: "^1.4.0" }, grants: [] },
      }),
    ).toBeUndefined();
  });

  it("returns manifest display metadata from describeMarketplacePlugin for installed plugins", async () => {
    const storageRoot = await makeStorageRoot("zcode-describe-metadata-");
    const pluginRoot = join(storageRoot, "cache", "hello-market", "hello", "1.2.3");
    await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "hello",
        version: "1.2.3",
        description: "hello plugin",
        author: { name: "Acme", url: "https://acme.dev" },
        homepage: "https://acme.dev/hello",
      }),
    );
    await writeFile(
      join(storageRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "hello@hello-market",
            name: "hello",
            marketplace: "hello-market",
            version: "1.2.3",
            installPath: pluginRoot,
            installedAt: new Date(0).toISOString(),
            scope: "user",
          },
        ],
      }),
    );

    const result = await describeMarketplacePlugin({
      marketplace: "hello-market",
      name: "hello",
      storageRoot,
    });
    expect(result.metadata).toEqual({
      author: "Acme",
      authorUrl: "https://acme.dev",
      homepage: "https://acme.dev/hello",
      version: "1.2.3",
    });
  });
});
