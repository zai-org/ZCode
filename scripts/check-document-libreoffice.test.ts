import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const check = resolve("scripts/check-document-libreoffice.mjs");
describe("document LibreOffice distribution gate", () => {
  it("accepts identical launchers and rejects a changed profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "document-launcher-gate-"));
    try {
      for (const name of ["documents", "pdf", "presentations", "spreadsheets"]) {
        await cp(
          `apps/zcode-cli/packages/${name}-plugin/scripts`,
          join(root, `${name}-plugin`, "scripts"),
          { recursive: true },
        );
      }
      await expect(exec(process.execPath, [check, root])).resolves.toMatchObject({ stderr: "" });
      await writeFile(
        join(root, "pdf-plugin/scripts/libreoffice-profile/user/registrymodifications.xcu"),
        "changed",
      );
      await expect(exec(process.execPath, [check, root])).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
