#!/usr/bin/env node
// import-design-system: builds a design-system file (see references/design-system.md) from a workspace's
// CSS custom properties, Tailwind config and existing HTML pages. Node standard library only.
// Tailwind configs are parsed as text and never executed; dynamic values are skipped and reported.
//
//   node import-design-system.mjs <workspace> [--name <name>] [--out <file>] [--from <path>]... [--force] [--stdout]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERIC_FAMILIES, colorKey, cssDeclarations, findColors, formatDesignSystem, htmlStyleSources,
  inlineDeclarations, lengthPx, normalizeFamily, parseColor, rgbKey, splitFamilies,
} from './design-tokens.mjs';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'design-system', 'target', '__pycache__']);
const TAILWIND = /^tailwind\.config\.(js|cjs|mjs|ts|cts|mts)$/;
const MAX_FILES = 2000;
const MAX_BYTES = 1024 * 1024;
const ROOT_SELECTOR = /(^|[\s,]):root\b|(^|[\s,])html\b|:host\b/;
// Channel-only custom properties (shadcn/ui and friends): `--primary: 221 83% 53%` used as hsl(var(--primary)).
const HSL_CHANNELS = /^-?[\d.]+(?:deg)?\s+[\d.]+%\s+[\d.]+%(?:\s*\/\s*[\d.]+%?)?$/;
const RGB_CHANNELS = /^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/;

// ---------------------------------------------------------------- file discovery

function walk(root, out) {
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path);
      } else if (entry.isFile() && classify(entry.name)) out.push(path);
    }
  }
  return out;
}

function classify(name) {
  if (TAILWIND.test(name)) return 'tailwind';
  const ext = extname(name).toLowerCase();
  if (ext === '.css' || ext === '.scss') return 'css';
  if (ext === '.html' || ext === '.htm') return 'html';
  return null;
}

export function discoverSources(workspace, from = []) {
  const files = [];
  if (from.length === 0) walk(workspace, files);
  for (const item of from) {
    const path = resolve(workspace, item);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  // Stylesheets first so their custom-property names win over Tailwind keys and page literals.
  const order = { css: 0, tailwind: 1, html: 2 };
  return [...new Set(files)]
    .filter((path) => classify(basename(path)) && statSync(path).size <= MAX_BYTES)
    .sort((a, b) => order[classify(basename(a))] - order[classify(basename(b))] || a.localeCompare(b));
}

// ---------------------------------------------------------------- tailwind (static parse, never executed)

const UNKNOWN = Symbol('unknown');
const WORD = /(?:[A-Za-z_$][\w$]*|\d[\d._]*(?:e[+-]?\d+)?|\.\.\.|=>)/y;

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let value = '';
      let dynamic = false;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') { value += source[j + 1] ?? ''; j += 2; continue; }
        if (c === '`' && source.startsWith('${', j)) dynamic = true;
        value += source[j];
        j += 1;
      }
      tokens.push({ type: dynamic ? 'dynamic' : 'string', value });
      i = j + 1;
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(source);
    if (word) {
      tokens.push({ type: /^[\d]/.test(word[0]) ? 'number' : /^[A-Za-z_$]/.test(word[0]) ? 'ident' : 'punct', value: word[0] });
      i += word[0].length;
      continue;
    }
    tokens.push({ type: 'punct', value: c });
    i += 1;
  }
  return tokens;
}

class LiteralParser {
  constructor(tokens, skipped) {
    this.tokens = tokens;
    this.pos = 0;
    this.skipped = skipped;
  }
  peek() { return this.tokens[this.pos]; }
  is(value) { return this.peek()?.type === 'punct' && this.peek().value === value; }
  // Skips one expression we do not understand (function, identifier, call, spread target...).
  skipExpression(label) {
    let depth = 0;
    const start = this.pos;
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token.type === 'punct') {
        if ('([{'.includes(token.value)) depth += 1;
        else if (')]}'.includes(token.value)) { if (depth === 0) break; depth -= 1; }
        else if (token.value === ',' && depth === 0) break;
      }
      this.pos += 1;
    }
    if (this.pos > start) this.skipped.push(label);
    return UNKNOWN;
  }
  value(label) {
    const token = this.peek();
    if (!token) return UNKNOWN;
    if (token.type === 'string' || token.type === 'number') {
      // A literal followed by an operator (`'a' + b`) is an expression we skip.
      const next = this.tokens[this.pos + 1];
      if (next && next.type === 'punct' && !',}]'.includes(next.value)) return this.skipExpression(label);
      this.pos += 1;
      return String(token.value);
    }
    if (this.is('{')) return this.object(label);
    if (this.is('[')) return this.array(label);
    return this.skipExpression(label);
  }
  object(label) {
    const result = {};
    this.pos += 1;
    while (this.pos < this.tokens.length && !this.is('}')) {
      if (this.is('...')) { this.pos += 1; this.skipExpression(`${label}.(spread)`); }
      else {
        const key = this.peek();
        if (key.type === 'ident' || key.type === 'string' || key.type === 'number') {
          this.pos += 1;
          if (this.is(':')) { this.pos += 1; result[key.value] = this.value(`${label}.${key.value}`); }
          else this.skipExpression(`${label}.${key.value}`);
        } else this.skipExpression(`${label}.(computed)`);
      }
      if (this.is(',')) this.pos += 1;
      else if (!this.is('}')) this.pos += 1;
    }
    this.pos += 1;
    return result;
  }
  array(label) {
    const result = [];
    this.pos += 1;
    while (this.pos < this.tokens.length && !this.is(']')) {
      result.push(this.value(`${label}[${result.length}]`));
      if (this.is(',')) this.pos += 1;
      else if (!this.is(']')) this.pos += 1;
    }
    this.pos += 1;
    return result;
  }
}

/** Reads `theme` (and `theme.extend`) from a Tailwind config's source text. */
export function parseTailwindTheme(source) {
  const tokens = tokenize(source);
  const skipped = [];
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (tokens[i].value === 'theme' && tokens[i + 1].value === ':' && tokens[i + 2].value === '{') {
      const parser = new LiteralParser(tokens, skipped);
      parser.pos = i + 2;
      const theme = parser.object('theme');
      const extend = theme.extend && theme.extend !== UNKNOWN ? theme.extend : {};
      const pick = (key) => [theme[key], extend[key]].filter((part) => part && part !== UNKNOWN && typeof part === 'object');
      return { colors: pick('colors'), fontFamily: pick('fontFamily'), spacing: pick('spacing'), borderRadius: pick('borderRadius'), skipped };
    }
  }
  return { colors: [], fontFamily: [], spacing: [], borderRadius: [], skipped };
}

function flatten(object, prefix, out) {
  for (const [key, value] of Object.entries(object)) {
    const name = key === 'DEFAULT' ? prefix : prefix ? `${prefix}-${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, name, out);
    else out.push([name, value]);
  }
  return out;
}

function quoteFamily(family) {
  return GENERIC_FAMILIES.has(family.toLowerCase()) || /^[\w-]+$/.test(family) ? family : `"${family}"`;
}

// ---------------------------------------------------------------- collection

function emptySystem() {
  return { colors: [], fonts: [], spacing: [], radii: [] };
}

function classifyCustomProperty(name, value) {
  const colors = findColors(value);
  if (colors.length === 1 && colors[0].text.length === value.trim().length) return 'colors';
  const lower = name.toLowerCase();
  if (/font|family|typeface/.test(lower) && !/size|weight|leading|line|height|tracking|spacing/.test(lower) && /[a-z]/i.test(value)) return 'fonts';
  if (/radius|rounded|corner/.test(lower) && lengthPx(value) !== null) return 'radii';
  if (/space|spacing|gap|gutter|pad|margin|inset/.test(lower) && lengthPx(value) !== null) return 'spacing';
  return null;
}

function resolveVars(value, defined, depth = 0) {
  if (depth > 5 || !value.includes('var(')) return value;
  const resolved = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => defined.get(name) ?? fallback?.trim() ?? whole);
  return resolveVars(resolved, defined, depth + 1);
}

/**
 * Builds a design system from source files. Returns { system, report } where report lists what was read,
 * skipped and inferred, for the usage notes and the CLI summary.
 */
export function importDesignSystem(workspace, files, name) {
  const system = emptySystem();
  const rootVars = new Map();
  const sources = new Set();
  const skipped = [];
  const literalColors = new Map();
  const literalFamilies = new Map();
  const literalSpacing = new Map();
  const rel = (path) => relative(workspace, path).split('\\').join('/') || basename(path);
  let tailwindUsed = false;

  // A token redefined with another value (a dark theme, a second stylesheet) is kept under a qualified label.
  const add = (section, token, value, use, source) => {
    const sameName = system[section].find((entry) => entry.token === token);
    if (sameName && sameName.value === value) return;
    const label = sameName ? `${token} (${use || source})` : token;
    if (system[section].some((entry) => entry.token === label)) return;
    system[section].push({ token: label, value, use });
    sources.add(source);
  };

  const readCss = (css, source) => {
    const decls = cssDeclarations(css);
    const defined = new Map();
    for (const decl of decls) if (decl.property.startsWith('--') && !defined.has(decl.property)) defined.set(decl.property, decl.value);
    for (const decl of decls) {
      if (decl.property.startsWith('--')) {
        let value = resolveVars(decl.value, defined).replace(/\s*!important$/, '').trim();
        const root = ROOT_SELECTOR.test(decl.selector);
        if (root && !rootVars.has(decl.property)) rootVars.set(decl.property, value);
        let use = root ? '' : decl.selector;
        if (HSL_CHANNELS.test(value) || RGB_CHANNELS.test(value)) {
          use = [use, `channels; use as ${HSL_CHANNELS.test(value) ? 'hsl' : 'rgb'}(var(${decl.property}))`].filter(Boolean).join('; ');
          value = `${HSL_CHANNELS.test(value) ? 'hsl' : 'rgb'}(${value})`;
        }
        const section = classifyCustomProperty(decl.property, value);
        if (section) add(section, decl.property, value, use, source);
      } else countLiterals(decl, source);
    }
  };

  const countLiterals = (decl, source) => {
    for (const found of findColors(decl.value)) bump(literalColors, colorKey(found.color), found.text, source);
    if (decl.property === 'font-family' && !decl.value.includes('var(')) {
      const primary = splitFamilies(decl.value).find((family) => !GENERIC_FAMILIES.has(normalizeFamily(family)));
      if (primary) bump(literalFamilies, normalizeFamily(primary), decl.value.replace(/\s*!important$/, ''), source);
    }
    if (/^(margin|padding|gap|row-gap|column-gap)/.test(decl.property) && !/var\(|calc\(/.test(decl.value)) {
      for (const part of decl.value.split(/\s+/)) {
        const px = lengthPx(part);
        if (px !== null) bump(literalSpacing, String(px), `${px}px`, source);
      }
    }
  };

  // Tailwind values that point at stylesheet variables (`hsl(var(--primary) / <alpha-value>)`) resolve to them.
  const viaVars = (raw) => (typeof raw === 'string' ? resolveVars(raw.replace(/\s*\/\s*<alpha-value>\s*/, ''), rootVars) : raw);

  for (const file of files) {
    const kind = classify(basename(file));
    const source = rel(file);
    const text = readFileSync(file, 'utf8');
    if (kind === 'css') readCss(text, source);
    else if (kind === 'html') {
      const styles = htmlStyleSources(text);
      for (const sheet of styles.sheets) readCss(sheet.css, source);
      for (const attribute of styles.attributes) for (const decl of inlineDeclarations(attribute.body)) countLiterals(decl, source);
    } else if (kind === 'tailwind') {
      const theme = parseTailwindTheme(text);
      tailwindUsed = true;
      skipped.push(...theme.skipped.map((label) => `${source}: ${label} (not a static literal; not executed)`));
      for (const part of theme.colors) {
        for (const [key, raw] of flatten(part, '', [])) {
          const value = viaVars(raw);
          if (typeof value === 'string' && parseColor(value)) add('colors', key, value, `tailwind colors${raw !== value ? ` (${raw})` : ''}`, source);
          else if (value !== UNKNOWN) skipped.push(`${source}: colors.${key} = ${String(value)} (not a color literal)`);
        }
      }
      for (const part of theme.fontFamily) {
        for (const [key, value] of Object.entries(part)) {
          const list = Array.isArray(value) ? (Array.isArray(value[0]) ? value[0] : value) : typeof value === 'string' ? value.split(',') : [];
          const families = list.filter((family) => typeof family === 'string').map((family) => family.trim().replace(/^['"]|['"]$/g, ''));
          if (families.length > 0) add('fonts', `font-${key}`, families.map(quoteFamily).join(', '), 'tailwind fontFamily', source);
        }
      }
      for (const [section, prefix, entries] of [['spacing', 'spacing', theme.spacing], ['radii', 'rounded', theme.borderRadius]]) {
        for (const part of entries) {
          for (const [key, raw] of flatten(part, '', [])) {
            const value = viaVars(raw);
            const label = `${section === 'radii' ? 'borderRadius' : 'spacing'}.${key || 'DEFAULT'}`;
            if (typeof value === 'string' && lengthPx(value) !== null) add(section, key ? `${prefix}-${key}` : prefix, value, `tailwind ${label}${raw !== value ? ` (${raw})` : ''}`, source);
            else if (value !== UNKNOWN) skipped.push(`${source}: ${label} = ${String(raw)} (not a plain length)`);
          }
        }
      }
    }
  }

  // Literal values used repeatedly but never named become candidates, so lint matches the existing pages.
  const named = system.colors.length + system.fonts.length > 0;
  const minimum = named ? 2 : 1;
  const coveredRgb = new Set(system.colors.map((entry) => rgbKey(parseColor(entry.value))));
  [...literalColors.entries()]
    .filter(([key, entry]) => entry.count >= minimum && !coveredRgb.has(rgbKey(parseColor(key))))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 16)
    .forEach(([, entry], index) => add('colors', `literal-color-${index + 1}`, entry.value, `literal, used ${entry.count}x`, [...entry.sources][0]));
  const coveredFamilies = new Set(system.fonts.flatMap((entry) => splitFamilies(entry.value).map(normalizeFamily)));
  [...literalFamilies.entries()]
    .filter(([family, entry]) => entry.count >= minimum && !coveredFamilies.has(family))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4)
    .forEach(([, entry], index) => add('fonts', `literal-font-${index + 1}`, entry.value, `literal, used ${entry.count}x`, [...entry.sources][0]));
  // A Tailwind project spaces with the default scale, which a few repeated literals would misrepresent.
  if (system.spacing.length === 0 && !tailwindUsed) {
    [...literalSpacing.entries()]
      .filter(([, entry]) => entry.count >= (named ? 3 : 1))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(0, 12)
      .forEach(([px, entry]) => add('spacing', `literal-space-${px}`, entry.value, `literal, used ${entry.count}x`, [...entry.sources][0]));
  }

  const usage = [
    `Imported by import-design-system.mjs from ${sources.size} file(s); review the roles before relying on it.`,
    '- Use these tokens only. Where a token is a CSS custom property, define it in `:root` and reference it as `var(--name)`.',
    '- `literal` tokens were used repeatedly in the source without a name; keep, rename or delete them.',
  ];
  if (tailwindUsed) usage.push('- Tailwind tokens keep the theme key path: `primary-500` is `theme.colors.primary.500`. The config was read as text, never executed. Tailwind\'s built-in palette and spacing scale are not listed; add the steps the design should use.');
  if (skipped.length > 0) usage.push(`- Skipped ${skipped.length} dynamic or non-literal value(s); add them by hand if they matter:`, ...skipped.slice(0, 12).map((line) => `  - ${line}`));
  return { system: { name, sources: [...sources].sort(), ...system, usage: usage.join('\n') }, report: { files: files.length, sources: sources.size, skipped } };
}

function bump(map, key, value, source) {
  const entry = map.get(key) ?? { value, count: 0, sources: new Set() };
  entry.count += 1;
  entry.sources.add(source);
  map.set(key, entry);
}

export function slugName(name) {
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return slug || 'design-system';
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const options = { from: [], force: false, stdout: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--name' || arg === '--out' || arg === '--from') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--from') options.from.push(value);
      else options[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--force') options.force = true;
    else if (arg === '--stdout') options.stdout = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error('expected exactly one workspace directory');
  return { workspace: resolve(positional[0]), ...options };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\nUsage: node import-design-system.mjs <workspace> [--name <name>] [--out <file>] [--from <path>]... [--force] [--stdout]`);
    return 2;
  }
  if (!existsSync(options.workspace) || !statSync(options.workspace).isDirectory()) {
    console.error(`Not a directory: ${options.workspace}`);
    return 2;
  }
  const name = slugName(options.name ?? basename(options.workspace));
  const files = discoverSources(options.workspace, options.from);
  const { system, report } = importDesignSystem(options.workspace, files, name);
  const markdown = formatDesignSystem(system);
  const counts = `${system.colors.length} colors, ${system.fonts.length} fonts, ${system.spacing.length} spacing, ${system.radii.length} radii from ${report.sources}/${report.files} file(s); ${report.skipped.length} skipped`;
  if (options.stdout) {
    process.stdout.write(markdown);
    console.error(counts);
    return 0;
  }
  const out = resolve(options.workspace, options.out ?? join('design-system', `${name}.md`));
  await mkdir(dirname(out), { recursive: true });
  // 不带 --force 时排他创建：存在检查与写入合成一步，并发导入同一路径只有一个能成功。
  try {
    await writeFile(out, markdown, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    console.error(`${out} already exists; pass --force to replace it or --name for another system.`);
    return 1;
  }
  console.log(out);
  console.log(counts);
  return 0;
}

const entry = process.argv[1] === undefined ? undefined : await realpath(process.argv[1]).catch(() => undefined);
if (entry !== undefined && entry === (await realpath(fileURLToPath(import.meta.url)))) process.exitCode = await main(process.argv.slice(2));
