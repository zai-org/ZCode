// Shared by design-lint.mjs and import-design-system.mjs: color parsing and the design-system file format.
// Node standard library only; nothing here touches the filesystem.

// ---------------------------------------------------------------- colors

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi;
const FUNC = /\b(?:rgba?|hsla?)\(\s*[^()]*\)/gi;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function channel(text) {
  const value = text.trim();
  if (value.endsWith('%')) return clamp(Math.round((parseFloat(value) / 100) * 255), 0, 255);
  return clamp(Math.round(parseFloat(value)), 0, 255);
}

function alpha(text) {
  if (text === undefined) return 1;
  const value = text.trim();
  return clamp(value.endsWith('%') ? parseFloat(value) / 100 : parseFloat(value), 0, 1);
}

function hue(text) {
  const value = text.trim().toLowerCase();
  const number = parseFloat(value);
  if (value.endsWith('turn')) return number * 360;
  if (value.endsWith('rad')) return (number * 180) / Math.PI;
  if (value.endsWith('grad')) return number * 0.9;
  return number;
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function splitArgs(inner) {
  // Accepts both "1, 2, 3, 0.5" and "1 2 3 / 50%".
  const [main, slash] = inner.split('/');
  const parts = main.split(/[\s,]+/).filter(Boolean);
  if (slash !== undefined) parts.push(slash.trim());
  return parts;
}

/** Parses one CSS color literal (hex, rgb[a], hsl[a]) into { r, g, b, a }, or null. */
export function parseColor(text) {
  const value = text.trim().toLowerCase();
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return null;
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  const match = value.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!match) return null;
  const args = splitArgs(match[2]);
  if (args.length < 3 || args.some((arg) => !/^[-+.\d]/.test(arg))) return null;
  if (match[1].startsWith('rgb')) return { r: channel(args[0]), g: channel(args[1]), b: channel(args[2]), a: alpha(args[3]) };
  const [r, g, b] = hslToRgb(((hue(args[0]) % 360) + 360) % 360, clamp(parseFloat(args[1]) / 100, 0, 1), clamp(parseFloat(args[2]) / 100, 0, 1));
  return { r, g, b, a: alpha(args[3]) };
}

/** Canonical lowercase hex: #rrggbb, or #rrggbbaa when not opaque. */
export function colorKey(color) {
  const hex = [color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return color.a >= 1 ? `#${hex}` : `#${hex}${Math.round(color.a * 255).toString(16).padStart(2, '0')}`;
}

export function rgbKey(color) {
  return colorKey({ ...color, a: 1 });
}

/** Every color literal in a CSS value, with its offset inside the value. */
export function findColors(value) {
  const found = [];
  for (const pattern of [HEX, FUNC]) {
    for (const match of value.matchAll(pattern)) {
      const color = parseColor(match[0]);
      if (color) found.push({ text: match[0], index: match.index, color });
    }
  }
  return found.sort((x, y) => x.index - y.index);
}

/** Perceptual-ish RGB distance ("redmean"); good enough to rank a nearest token. */
export function colorDistance(x, y) {
  const mean = (x.r + y.r) / 2;
  const dr = x.r - y.r;
  const dg = x.g - y.g;
  const db = x.b - y.b;
  return Math.sqrt((2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db);
}

// ---------------------------------------------------------------- CSS scanning

/** Replaces comments with spaces so offsets (and therefore line numbers) stay valid. */
export function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * Declarations of a stylesheet: { selector, property, value, offset } where offset points at the value.
 * Only innermost blocks hold declarations, so @media and other wrappers need no special casing.
 */
export function cssDeclarations(css) {
  const text = blankComments(css);
  const out = [];
  for (const block of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = block[1].trim().split(/[;\n]/).pop().trim();
    const bodyStart = block.index + block[0].indexOf('{') + 1;
    out.push(...inlineDeclarations(block[2], bodyStart).map((decl) => ({ selector, ...decl })));
  }
  return out;
}

/** Declarations of a style attribute body (no braces). */
export function inlineDeclarations(body, baseOffset = 0) {
  const out = [];
  let cursor = 0;
  for (const piece of body.split(';')) {
    const colon = piece.indexOf(':');
    if (colon > 0) {
      const property = piece.slice(0, colon).trim().toLowerCase();
      const rawValue = piece.slice(colon + 1);
      const lead = rawValue.length - rawValue.trimStart().length;
      if (/^-{0,2}[a-z][\w-]*$/i.test(property)) {
        out.push({ property, value: rawValue.trim(), offset: baseOffset + cursor + colon + 1 + lead });
      }
    }
    cursor += piece.length + 1;
  }
  return out;
}

/** Style sheets and style attributes of an HTML document, with offsets into the document. */
export function htmlStyleSources(html) {
  const sheets = [];
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    sheets.push({ css: match[1], offset: match.index + match[0].indexOf('>') + 1 });
  }
  const attributes = [];
  for (const match of html.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const body = match[2] ?? match[3] ?? '';
    attributes.push({ body, offset: match.index + match[0].indexOf(match[1]) + 1 });
  }
  const presentational = [];
  for (const match of html.matchAll(/\s(fill|stroke|color|stop-color|flood-color|bgcolor)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const value = match[3] ?? match[4] ?? '';
    presentational.push({ property: match[1].toLowerCase(), value, offset: match.index + match[0].indexOf(match[2]) + 1 });
  }
  return { sheets, attributes, presentational };
}

export function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

// ---------------------------------------------------------------- fonts and lengths

export const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer',
]);

export function splitFamilies(value) {
  return value
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

export function normalizeFamily(family) {
  return family.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

/** The family list inside a `font` shorthand, or null for keywords and var() values. */
export function familiesFromFontShorthand(value) {
  if (/var\(/.test(value)) return null;
  const match = value.match(/(?:^|\s)[\d.]+(?:px|r?em|pt|%|vw|vh|ch|ex)?(?:\s*\/\s*[\w.%-]+)?\s+(.+)$/i);
  return match ? match[1] : null;
}

/** A plain length in px (rem/em counted at 16px), or null for 0, auto, %, calc, var and friends. */
export function lengthPx(token) {
  const match = token.trim().toLowerCase().match(/^(-?[\d.]+)(px|rem|em)$/);
  if (!match) return null;
  const number = parseFloat(match[1]);
  if (number === 0) return null;
  return Math.abs(match[2] === 'px' ? number : number * 16);
}

// ---------------------------------------------------------------- design-system file

export const SECTIONS = ['colors', 'fonts', 'spacing', 'radii'];

const SECTION_ALIASES = {
  colors: /^(colou?rs?|palette)\b/i,
  fonts: /^(fonts?|typography|type|font families)\b/i,
  spacing: /^(spacing|space|spaces)\b/i,
  radii: /^(radii|radius|corner radii|border radius)\b/i,
};

function unquoteCell(cell) {
  return cell.trim().replace(/\\\|/g, '|').replace(/^`([\s\S]*)`$/, '$1').trim();
}

function tableCells(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map(unquoteCell);
}

/**
 * Reads a design-system file. Markdown: `## Colors` / `## Fonts` / `## Spacing` / `## Radii` sections
 * holding `| token | value | use |` tables (or `- token: value` items). JSON: the same keys, each an object
 * of token -> value or a list of { token, value, use }.
 */
export function parseDesignSystem(text, path = '') {
  const system = { name: '', colors: [], fonts: [], spacing: [], radii: [], usage: '' };
  const trimmed = text.trim();
  if (path.toLowerCase().endsWith('.json') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed);
    system.name = typeof data.name === 'string' ? data.name : '';
    system.usage = typeof data.usage === 'string' ? data.usage : '';
    for (const section of SECTIONS) {
      const entries = data[section];
      if (Array.isArray(entries)) {
        for (const entry of entries) if (entry && entry.token && entry.value) system[section].push({ token: String(entry.token), value: String(entry.value), use: String(entry.use ?? '') });
      } else if (entries && typeof entries === 'object') {
        for (const [token, value] of Object.entries(entries)) system[section].push({ token, value: Array.isArray(value) ? value.join(', ') : String(value), use: '' });
      }
    }
    return system;
  }
  const front = trimmed.match(/^---\n([\s\S]*?)\n---/);
  if (front) system.name = front[1].match(/^name:\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '') ?? '';
  let section = null;
  const usage = [];
  for (const line of text.split('\n')) {
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      section = SECTIONS.find((name) => SECTION_ALIASES[name].test(heading[1])) ?? (/^usage\b/i.test(heading[1]) ? 'usage' : null);
      continue;
    }
    if (!system.name) system.name = line.match(/^#\s+(.+?)\s*$/)?.[1] ?? '';
    if (section === 'usage') {
      usage.push(line);
      continue;
    }
    if (!section) continue;
    if (/^\s*\|/.test(line)) {
      const cells = tableCells(line);
      if (cells.length < 2 || /^:?-{2,}:?$/.test(cells[0]) || /^token$/i.test(cells[0])) continue;
      if (cells[0] && cells[1]) system[section].push({ token: cells[0], value: cells[1], use: cells[2] ?? '' });
      continue;
    }
    const item = line.match(/^\s*[-*]\s+`?([^`:]+?)`?\s*:\s*`?([^`]+?)`?\s*(?:[—-]\s*(.*))?$/);
    if (item) system[section].push({ token: item[1].trim(), value: item[2].trim(), use: item[3]?.trim() ?? '' });
  }
  system.usage = usage.join('\n').trim();
  return system;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

const TITLES = { colors: 'Colors', fonts: 'Fonts', spacing: 'Spacing', radii: 'Radii' };

/** Writes the markdown form read by parseDesignSystem. */
export function formatDesignSystem(system) {
  const lines = ['---', `name: ${system.name}`];
  if (system.sources?.length) {
    lines.push('sources:');
    for (const source of system.sources) lines.push(`  - ${source}`);
  }
  lines.push('---', '', `# ${system.name}`, '');
  lines.push('Design-system file for the design skill. `design-lint.mjs` reads the four token tables; keep their layout. Edit values and the usage notes freely.', '');
  for (const section of SECTIONS) {
    lines.push(`## ${TITLES[section]}`, '');
    const entries = system[section] ?? [];
    if (entries.length === 0) {
      lines.push('None found in the sources. Add tokens here if the design should be bound to them.', '');
      continue;
    }
    lines.push('| Token | Value | Use |', '| --- | --- | --- |');
    for (const entry of entries) lines.push(`| \`${cell(entry.token)}\` | \`${cell(entry.value)}\` | ${cell(entry.use ?? '')} |`);
    lines.push('');
  }
  lines.push('## Usage', '', system.usage ?? '', '');
  return lines.join('\n');
}
