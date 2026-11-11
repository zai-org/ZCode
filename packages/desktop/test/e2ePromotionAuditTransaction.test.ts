import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  runPromotionAuditTransaction,
  runPromotionCoverageAudit,
} from "../scripts/lib/e2e-promotion-audit-transaction.mjs";
import { rewriteFormalSpecImports } from "../scripts/lib/e2e-promotion-spec-imports.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("conversation E2E promotion audit transaction", () => {
  it("rewrites pending spec imports for the formal spec location", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-e2e-promotion-imports-"));
    temporaryRoots.push(root);
    const specPath = join(root, "case.test.ts");
    await writeFile(
      specPath,
      [
        'import "../../../helpers/session.js";',
        'import "../../../pages/conversation.js";',
        'import "../../../bots/helpers/bots-service-harness.js";',
        'import fixture from "../../../fixtures/conversation-session/sample.json";',
        'import deep from "../../../../../fixtures/deep.json";',
        'import alreadyFormal from "../fixtures/unchanged.json";',
        "",
      ].join("\n"),
    );

    rewriteFormalSpecImports(specPath);

    await expect(readFile(specPath, "utf8")).resolves.toBe(
      [
        'import "../helpers/session.js";',
        'import "../pages/conversation.js";',
        'import "../bots/helpers/bots-service-harness.js";',
        'import fixture from "../fixtures/conversation-session/sample.json";',
        'import deep from "../../../fixtures/deep.json";',
        'import alreadyFormal from "../fixtures/unchanged.json";',
        "",
      ].join("\n"),
    );
  });

  it("returns the real coverage audit process result to the promotion gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-e2e-promotion-audit-command-"));
    temporaryRoots.push(root);
    const auditPath = join(root, "audit.mjs");
    await writeFile(
      auditPath,
      'process.stdout.write("formal admission: rejected\\n"); process.exitCode = 1;\n',
    );

    const result = await runPromotionCoverageAudit({ auditPath, repoRoot: root });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("formal admission: rejected");
    expect(result.command).toBe("pnpm audit:conversation-session-coverage");
  });

  it("restores every promotion file when coverage audit fails", async () => {
    const fixture = await createPromotionFixture();

    const result = await runPromotionAuditTransaction({
      affectedPaths: fixture.affectedPaths,
      applyChanges: () => applyProbePromotion(fixture),
      runAudit: async () => ({ exitCode: 1, stderr: "formal admission rejected", stdout: "" }),
    });

    expect(result.committed).toBe(false);
    expect(result.rolledBack).toBe(true);
    await expect(readFile(fixture.sourcePath, "utf8")).resolves.toBe(fixture.originalSpec);
    await expect(readFile(fixture.targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.providerFixturePath, "utf8")).resolves.toBe(
      fixture.originalProviderFixture,
    );
    await expect(readFile(fixture.caseManifestPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(fixture.matrixPath, "utf8")).resolves.toBe(fixture.originalMatrix);
  });

  it("keeps the promoted files only when coverage audit passes", async () => {
    const fixture = await createPromotionFixture();

    const result = await runPromotionAuditTransaction({
      affectedPaths: fixture.affectedPaths,
      applyChanges: () => applyProbePromotion(fixture),
      runAudit: async () => ({ exitCode: 0, stderr: "", stdout: "audit passed" }),
    });

    expect(result.committed).toBe(true);
    expect(result.rolledBack).toBe(false);
    await expect(readFile(fixture.sourcePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.targetPath, "utf8")).resolves.toBe("formal spec\n");
    await expect(readFile(fixture.providerFixturePath, "utf8")).resolves.toBe(
      "promoted provider fixture\n",
    );
    await expect(readFile(fixture.caseManifestPath, "utf8")).resolves.toBe(
      "promoted case manifest\n",
    );
    await expect(readFile(fixture.matrixPath, "utf8")).resolves.toBe("formal matrix path\n");
  });

  it("restores every promotion file when the audit process cannot run", async () => {
    const fixture = await createPromotionFixture();

    await expect(
      runPromotionAuditTransaction({
        affectedPaths: fixture.affectedPaths,
        applyChanges: () => applyProbePromotion(fixture),
        runAudit: async () => {
          throw new Error("audit process unavailable");
        },
      }),
    ).rejects.toThrow("audit process unavailable");

    await expect(readFile(fixture.sourcePath, "utf8")).resolves.toBe(fixture.originalSpec);
    await expect(readFile(fixture.targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.providerFixturePath, "utf8")).resolves.toBe(
      fixture.originalProviderFixture,
    );
    await expect(readFile(fixture.caseManifestPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(fixture.matrixPath, "utf8")).resolves.toBe(fixture.originalMatrix);
  });
});

async function createPromotionFixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-e2e-promotion-audit-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, "pending", "case.test.ts");
  const targetPath = join(root, "formal", "case.test.ts");
  const providerFixturePath = join(root, "fixtures", "provider.json");
  const caseManifestPath = join(root, "fixtures", "manifest.json");
  const matrixPath = join(root, "coverage.md");
  const originalSpec = "pending spec\n";
  const originalProviderFixture = "pending provider fixture\n";
  const originalMatrix = "pending matrix path\n";
  await Promise.all([
    mkdir(join(root, "pending"), { recursive: true }),
    mkdir(join(root, "fixtures"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(sourcePath, originalSpec),
    writeFile(providerFixturePath, originalProviderFixture),
    writeFile(matrixPath, originalMatrix),
  ]);
  return {
    affectedPaths: [sourcePath, targetPath, providerFixturePath, caseManifestPath, matrixPath],
    caseManifestPath,
    matrixPath,
    originalMatrix,
    originalProviderFixture,
    originalSpec,
    providerFixturePath,
    sourcePath,
    targetPath,
  };
}

async function applyProbePromotion(fixture: Awaited<ReturnType<typeof createPromotionFixture>>) {
  await mkdir(dirname(fixture.targetPath), { recursive: true });
  await rename(fixture.sourcePath, fixture.targetPath);
  await Promise.all([
    writeFile(fixture.targetPath, "formal spec\n"),
    writeFile(fixture.providerFixturePath, "promoted provider fixture\n"),
    writeFile(fixture.caseManifestPath, "promoted case manifest\n"),
    writeFile(fixture.matrixPath, "formal matrix path\n"),
  ]);
}
