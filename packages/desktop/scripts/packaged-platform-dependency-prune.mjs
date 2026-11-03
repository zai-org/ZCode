import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

function normalizeConstraint(value) {
  if (value == null) return null;
  return (Array.isArray(value) ? value : [value]).filter(
    (entry) => typeof entry === "string" && entry.length > 0,
  );
}

function matchesConstraint(targets, constraint) {
  if (!constraint) return true;
  if (constraint.length === 1 && constraint[0] === "any") return true;

  let hasPositive = false;
  let positiveMatch = false;
  let negativeCount = 0;
  for (const target of targets) {
    for (const entry of constraint) {
      if (entry.startsWith("!")) {
        negativeCount += 1;
        if (entry.slice(1) === target) return false;
      } else {
        hasPositive = true;
        positiveMatch ||= entry === target;
      }
    }
  }
  return positiveMatch || (!hasPositive && negativeCount === constraint.length);
}

function isCompatible(packageJson, targetPlatform) {
  return (
    matchesConstraint([targetPlatform.os], normalizeConstraint(packageJson.os)) &&
    matchesConstraint([targetPlatform.arch], normalizeConstraint(packageJson.cpu))
  );
}

async function prunePackageDirectory(packageDirectory, targetPlatform, summary) {
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
    throw error;
  }

  if (!isCompatible(packageJson, targetPlatform)) {
    await rm(packageDirectory, { recursive: true, force: true });
    summary.packagesRemoved += 1;
    summary.removedNames.push(packageJson.name ?? packageDirectory);
    return;
  }

  await pruneNodeModulesDirectory(join(packageDirectory, "node_modules"), targetPlatform, summary);
}

async function pruneNodeModulesDirectory(nodeModulesDirectory, targetPlatform, summary) {
  let entries;
  try {
    entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(nodeModulesDirectory, entry.name);
    if (entry.name.startsWith("@")) {
      const scopedEntries = await readdir(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          await prunePackageDirectory(join(entryPath, scopedEntry.name), targetPlatform, summary);
        }
      }
    } else {
      await prunePackageDirectory(entryPath, targetPlatform, summary);
    }
  }
}

export async function pruneIncompatiblePlatformPackages(rootDirectory, targetPlatform) {
  const summary = { packagesRemoved: 0, removedNames: [] };
  await pruneNodeModulesDirectory(join(rootDirectory, "node_modules"), targetPlatform, summary);
  return summary;
}
