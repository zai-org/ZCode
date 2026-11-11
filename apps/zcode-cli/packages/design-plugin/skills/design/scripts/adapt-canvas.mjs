// Explicit authoring helper. It never runs during pack loading or changes the source template.
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('../design-resources/skills/infinite-canvas/assets/infinite-canvas-template.html', import.meta.url));
const sourceSha256 = '50228cdd4d4b7a2584f8d66e1cbd64cd06c4718005dcbdb2332c997ee7c665d1';

export function adaptCanvasTemplate(html) {
  if (createHash('sha256').update(html, 'utf8').digest('hex') !== sourceSha256) {
    throw new Error('Canvas source changed; review the adaptations and update the pinned source hash before generating a draft.');
  }
  const edits = [
    ['</style>', '@media (prefers-reduced-motion: reduce) {\n    *, *::before, *::after { animation: none !important; transition: none !important; }\n  }\n</style>'],
    ["'Undo / Redo'", "'Undo layout changes'"],
    ["kbdHints: [['Scroll', 'pan'], ['\\u2318Scroll', 'zoom'], ['\\u2318Z', 'undo']],", "kbdHints: [['Scroll', 'pan'], ['Ctrl / ⌘ + Scroll', 'zoom'], ['Ctrl / ⌘ + Z', 'undo']],"],
    ["document.addEventListener('keydown', (e) => {", "document.addEventListener('keydown', (e) => {\n    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;"],
    ['if (e.button !== 0) return;', "if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button, a, input, textarea, select, [contenteditable]'))) return;"],
  ];
  for (const [before, after] of edits) {
    if (html.split(before).length !== 2) throw new Error('Canvas adaptation anchor must occur exactly once.');
    html = html.replace(before, after);
  }
  return html;
}

// Stdin and synthetic entry paths need not resolve when this helper is imported.
const scriptPath = process.argv[1];
const entryPath = scriptPath === undefined ? undefined : await realpath(scriptPath).catch(() => undefined);
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || extname(process.argv[2]).toLowerCase() !== '.html') {
      throw new Error('Usage: node adapt-canvas.mjs <new-output.html>');
    }
    const outputPath = resolve(process.argv[2]);
    const html = adaptCanvasTemplate(await readFile(sourcePath, 'utf8'));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, { encoding: 'utf8', flag: 'wx' });
    console.log(outputPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
