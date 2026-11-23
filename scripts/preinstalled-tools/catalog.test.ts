import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  preinstalledToolsCatalogSchema,
  resolvePreinstalledToolsCatalog,
} from "@zcode/shared/preinstalled-tools";

const resource = {
  toolId: "qpdf",
  resourceId: "qpdf-12.3-darwin-arm64-r1",
  version: "12.3",
  platforms: [{ platform: "darwin", arch: "arm64" }],
  binaryArch: "arm64",
  archive: {
    format: "tar.gz",
    sizeBytes: 100,
    sha256: "a".repeat(64),
    path: "qpdf/qpdf-12.3-darwin-arm64-r1/qpdf-12.3-darwin-arm64-r1.tar.gz",
  },
  installedSizeBytes: 200,
  requiredFiles: ["bin/qpdf"],
  entries: [{ name: "qpdf", target: "bin/qpdf", args: [], env: [] }],
  runtimeChecks: [
    { entry: "qpdf", args: ["--version"], expectedOutput: "qpdf version 12.3", timeoutMs: 30000 },
  ],
};
const tool = { toolId: "qpdf", displayName: "qpdf", resources: [resource] };

describe("published built-in resource catalog", () => {
  it("ships the 15 published archives with canonical relative paths", async () => {
    const catalog = preinstalledToolsCatalogSchema.parse(
      JSON.parse(
        await readFile(
          new URL("../../packages/desktop/src/preinstalled-tools/catalog.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(catalog.map((entry) => entry.toolId)).toEqual([
      "python",
      "qpdf",
      "pandoc",
      "poppler",
      "libreoffice",
    ]);
    expect(catalog.flatMap((entry) => entry.resources)).toHaveLength(15);
    for (const entry of catalog)
      for (const resource of entry.resources) {
        expect(resource.archive.path).toBe(
          `${entry.toolId}/${resource.resourceId}/${resource.resourceId}.tar.gz`,
        );
      }
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
    ]) {
      const { tools, downloadBaseUrlsError } = resolvePreinstalledToolsCatalog(
        catalog,
        platform!,
        arch!,
        ["https://cdn.example.com/zcode/preinstalled-tools"],
      );
      expect(downloadBaseUrlsError).toBeUndefined();
      expect(tools.every((item) => item.manifest !== null)).toBe(true);
    }
    expect(
      resolvePreinstalledToolsCatalog(catalog, "win32", "arm64", ["https://cdn.example.com"])
        .tools.filter((item) => item.manifest)
        .map((item) => item.toolId),
    ).toEqual(["pandoc", "poppler"]);
    for (const arch of ["x64", "arm64"]) {
      expect(
        resolvePreinstalledToolsCatalog(catalog, "linux", arch, [
          "https://cdn.example.com",
        ]).tools.every((item) => item.manifest === null),
      ).toBe(true);
    }
  });
});

describe("preinstalled resource catalog publication", () => {
  it("accepts unpublished tools without download targets", () => {
    expect(
      preinstalledToolsCatalogSchema.safeParse([
        tool,
        { toolId: "python", displayName: "Python", resources: [] },
      ]).success,
    ).toBe(true);
  });
  it("rejects duplicate tool identities", () => {
    expect(preinstalledToolsCatalogSchema.safeParse([tool, tool]).success).toBe(false);
  });
  it("rejects overlapping platform resources and entry names across tools", () => {
    expect(
      preinstalledToolsCatalogSchema.safeParse([
        { ...tool, resources: [resource, { ...resource, resourceId: "qpdf-other" }] },
      ]).success,
    ).toBe(false);
    expect(
      preinstalledToolsCatalogSchema.safeParse([
        tool,
        { toolId: "python", displayName: "Python", resources: [{ ...resource, toolId: "python" }] },
      ]).success,
    ).toBe(false);
  });
  it("rejects missing entry targets, foreign runtime checks, unsafe paths and full URLs", () => {
    for (const broken of [
      { ...resource, requiredFiles: ["other"] },
      { ...resource, entries: [...resource.entries, ...resource.entries] },
      { ...resource, runtimeChecks: [{ ...resource.runtimeChecks[0], entry: "foreign" }] },
      { ...resource, downloadUrls: ["https://explicit.example.com/qpdf.tar.gz"] },
      {
        ...resource,
        archive: {
          ...resource.archive,
          downloadUrls: ["https://explicit.example.com/qpdf.tar.gz"],
        },
      },
      {
        ...resource,
        archive: {
          ...resource.archive,
          downloadUrlsByRegion: {
            domestic: ["https://cn.example.com/qpdf.tar.gz"],
            overseas: ["https://global.example.com/qpdf.tar.gz"],
          },
        },
      },
      ...[
        "https://cdn.example.com/qpdf.tar.gz",
        "/qpdf.tar.gz",
        "../qpdf.tar.gz",
        "qpdf\\a.tar.gz",
      ].map((path) => ({ ...resource, archive: { ...resource.archive, path } })),
      { ...resource, archive: { ...resource.archive, path: undefined } },
      { ...resource, toolId: "python" },
    ])
      expect(
        preinstalledToolsCatalogSchema.safeParse([{ ...tool, resources: [broken] }]).success,
      ).toBe(false);
  });
  it("allows one tool's entry on distinct native and emulated platforms", () => {
    const windows = {
      ...resource,
      resourceId: "qpdf-win-x64-r1",
      platforms: [
        { platform: "win32", arch: "x64" },
        { platform: "win32", arch: "arm64" },
      ],
      binaryArch: "x64",
    };
    expect(
      preinstalledToolsCatalogSchema.safeParse([{ ...tool, resources: [resource, windows] }])
        .success,
    ).toBe(true);
  });
  it("accepts declared installation rewrites and rejects unsafe paths or placeholders", () => {
    const rewrite = [{ path: "lib/data.bin", placeholder: "/build/prefix", mode: "binary" }];
    expect(
      preinstalledToolsCatalogSchema.parse([{ ...tool, resources: [{ ...resource, rewrite }] }])[0]
        ?.resources[0]?.rewrite,
    ).toEqual(rewrite);
    for (const item of [
      { ...rewrite[0], path: "../outside" },
      { ...rewrite[0], path: "lib\\data.bin" },
      { ...rewrite[0], placeholder: "" },
      { ...rewrite[0], placeholder: "bad\0prefix" },
      { ...rewrite[0], mode: "script" },
    ])
      expect(
        preinstalledToolsCatalogSchema.safeParse([
          { ...tool, resources: [{ ...resource, rewrite: [item] }] },
        ]).success,
      ).toBe(false);
  });
});

it("accepts directory-prefix rewrites on POSIX resources but rejects Windows declarations", () => {
  const rewrite = [
    { path: "lib/data.bin", placeholder: "/build/prefix", mode: "binary-dir-prefix" },
  ];
  expect(
    preinstalledToolsCatalogSchema.parse([{ ...tool, resources: [{ ...resource, rewrite }] }])[0]
      ?.resources[0]?.rewrite,
  ).toEqual(rewrite);
  expect(
    preinstalledToolsCatalogSchema.safeParse([
      {
        ...tool,
        resources: [{ ...resource, rewrite, platforms: [{ platform: "win32", arch: "x64" }] }],
      },
    ]).success,
  ).toBe(false);
});

describe("download address assembly", () => {
  const catalog = [
    {
      ...tool,
      resources: [{ ...resource, archive: { ...resource.archive, path: "qpdf/v1+b/a b.tar.gz" } }],
    },
  ];
  it("joins the encoded path onto each base in order and drops repeated candidates", () => {
    const {
      tools: [configuration],
      downloadBaseUrlsError,
    } = resolvePreinstalledToolsCatalog(catalog, "darwin", "arm64", [
      "https://cn.example.com/zcode/preinstalled-tools/",
      "http://127.0.0.1:8080",
      "https://cn.example.com/zcode/preinstalled-tools",
    ]);
    expect(downloadBaseUrlsError).toBeUndefined();
    expect(configuration?.manifest?.downloadUrls).toEqual([
      "https://cn.example.com/zcode/preinstalled-tools/qpdf/v1%2Bb/a%20b.tar.gz",
      "http://127.0.0.1:8080/qpdf/v1%2Bb/a%20b.tar.gz",
    ]);
    expect(
      resolvePreinstalledToolsCatalog(catalog, "linux", "x64", ["https://cn.example.com"]).tools[0]
        ?.manifest,
    ).toBeNull();
  });
  // 基址写错曾让整个装配失败，Main 以空列表交给预装进程，已安装资源被当作移出 catalog 删除。
  it("keeps every tool without a target for missing or non-HTTP bases instead of falling back", () => {
    for (const bases of [
      [],
      ["file:///tmp/tools"],
      ["not-a-url"],
      ["cdn.example.com/zcode/preinstalled-tools"],
      ["https://cn.example.com", "ftp://x.example.com"],
    ]) {
      const { tools, downloadBaseUrlsError } = resolvePreinstalledToolsCatalog(
        catalog,
        "darwin",
        "arm64",
        bases,
      );
      expect(tools).toEqual([{ toolId: "qpdf", displayName: "qpdf", manifest: null }]);
      expect(downloadBaseUrlsError).toBeDefined();
    }
  });
  it("still rejects an invalid catalog even when bases are invalid", () => {
    expect(() =>
      resolvePreinstalledToolsCatalog([tool, tool], "darwin", "arm64", ["not-a-url"]),
    ).toThrow();
  });
});
