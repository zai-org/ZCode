#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root =
  process.argv[2] || fileURLToPath(new URL("../apps/zcode-cli/packages", import.meta.url));
async function files(directory, relative = "") {
  const found = [];
  for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = join(relative, item.name);
    if (item.isDirectory()) found.push(...(await files(directory, path)));
    else if (item.isFile()) found.push(path);
    else throw new Error(`Unexpected launcher profile entry: ${path}`);
  }
  return found.sort();
}
try {
  const reference = resolve(root, "documents-plugin/scripts");
  const profile = "libreoffice-profile";
  const expected = await files(join(reference, profile));
  for (const name of ["pdf", "presentations", "spreadsheets"]) {
    const target = resolve(root, `${name}-plugin/scripts`);
    const actual = await files(join(target, profile));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(`${name}: profile file set differs`);
    for (const file of ["zcode_libreoffice.py", ...expected.map((path) => join(profile, path))]) {
      const [a, b] = await Promise.all([
        readFile(join(reference, file)),
        readFile(join(target, file)),
      ]);
      if (!a.equals(b)) throw new Error(`${name}: ${file} differs`);
    }
  }
  process.stdout.write("Document LibreOffice launchers and profiles are identical.\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
