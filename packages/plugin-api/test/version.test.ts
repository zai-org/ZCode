// 类型包的版本钉在扩展 API 版本上（docs/plugins/extension-host.md §17.9）：
// 插件作者按包版本判断能用哪些能力，两处不一致就会装错版本。
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// 示例插件与类型包都不在 shared 的依赖链上，这里按相对路径读协议源码，只取这一个常量。
import { EXTENSION_API_VERSION } from "../../shared/src/extension-host/manifest.js";

describe("@zcode-dev/plugin-api version", () => {
  it("equals EXTENSION_API_VERSION", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    expect(manifest.version).toBe(EXTENSION_API_VERSION);
  });
});
