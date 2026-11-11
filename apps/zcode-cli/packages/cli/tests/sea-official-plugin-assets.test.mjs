import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  collectSeaOfficialPluginAssets,
  officialSeaPlugins,
} from "../scripts/sea-official-plugin-assets.mjs";

test("rejects an incomplete documents SEA seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-document-agent-missing-"));
  const root = join(directory, "root");
  const stagingDirectory = join(directory, "staging");

  try {
    // 夹具必须覆盖清单里除 documents 之外的所有条目：collect 按清单顺序对每个
    // 条目先校验 manifest 与 seed 资产，任何先于 documents 的条目缺资产都会
    // 以别的错误先抛，让本测试想覆盖的 documents 拒绝路径永远走不到（历史上
    // visualize 排到首位后该测试就一直红在 visualize manifest 缺失上）。
    for (const entry of officialSeaPlugins) {
      if (entry.name === "documents") {
        await writeTestFile(root, join(entry.rootPath, ".zcode-plugin/plugin.json"), "{}");
        continue;
      }
      await writeTestFile(root, join(entry.rootPath, ".zcode-plugin/plugin.json"), "{}");
      for (const seedPath of entry.requiredSeedPaths ?? [])
        await writeTestFile(root, join(entry.rootPath, seedPath), "");
    }

    await assert.rejects(
      collectSeaOfficialPluginAssets({ root, stagingDirectory }),
      /Missing documents required seed asset.*agents[/\\]visual-judge\.md/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function writeTestFile(root, relativePath, content) {
  const filePath = join(root, ...String(relativePath).split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
