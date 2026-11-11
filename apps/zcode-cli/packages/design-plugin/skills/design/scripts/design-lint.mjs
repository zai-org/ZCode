#!/usr/bin/env node
// design-lint: checks that the colors, font families and (optionally) spacing in an HTML design file come
// from a design-system file. Node standard library only; reads files, writes nothing.
//
//   node design-lint.mjs <page.html> [<design-system.md|.json>] [--spacing] [--json]
//
// Exit codes: 0 no violations, 1 violations, 2 usage or read error.
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  GENERIC_FAMILIES, colorDistance, colorKey, cssDeclarations, familiesFromFontShorthand, findColors,
  htmlStyleSources, inlineDeclarations, lengthPx, lineAt, normalizeFamily, parseColor, parseDesignSystem,
  rgbKey, splitFamilies,
} from './design-tokens.mjs';

const SPACING_PROPERTIES = /^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;

function decodeEntities(text) {
  return text.replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Every declaration in the page, with absolute offsets so each finding has a line number. */
export function pageDeclarations(html) {
  const { sheets, attributes, presentational } = htmlStyleSources(html);
  const declarations = [];
  for (const sheet of sheets) {
    for (const decl of cssDeclarations(sheet.css)) declarations.push({ ...decl, offset: sheet.offset + decl.offset, where: 'style' });
  }
  for (const attribute of attributes) {
    // Entities never span lines, so decoding first keeps line numbers exact.
    for (const decl of inlineDeclarations(decodeEntities(attribute.body), attribute.offset)) declarations.push({ ...decl, where: 'inline' });
  }
  for (const attribute of presentational) declarations.push({ ...attribute, where: 'attribute' });
  return declarations;
}

function nearestColor(color, tokens) {
  let best = null;
  for (const token of tokens) {
    const distance = colorDistance(color, token.color);
    if (!best || distance < best.distance) best = { token, distance };
  }
  return best && `${best.token.token} (${best.token.value})`;
}

function nearestLength(px, tokens) {
  let best = null;
  for (const token of tokens) {
    const distance = Math.abs(px - token.px);
    if (!best || distance < best.distance) best = { token, distance };
  }
  return best && `${best.token.token} (${best.token.value})`;
}

/**
 * Lints one page against an optional design system (as returned by parseDesignSystem).
 * Returns { violations, warnings, notes, stats }.
 */
// 字体栈常放在任意名字的自定义属性里（--font-sans、--app-font-sans、--heading-font），页面再 var() 引用；
// 名字带 font 的都按字体栈查，字号、字重这类同名族属性除外；值也得像字体栈（不是颜色、数字、关键字或 font 简写）。
const FONT_METRIC_PROPERTY = /size|weight|style|stretch|feature|variation|smooth|kerning|synthesis|optical|height|leading|spacing|scale/;
const NON_FAMILY_VALUE = /^(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|calc\(|[-+.\d])/i;
const NON_FAMILY_KEYWORD = new Set(['swap', 'block', 'fallback', 'optional', 'auto', 'normal', 'bold', 'bolder', 'lighter', 'italic', 'oblique', 'inherit', 'initial', 'unset', 'revert', 'none', 'transparent', 'currentcolor']);
function isFontStackProperty(property, value) {
  if (!property.startsWith('--') || !property.includes('font') || FONT_METRIC_PROPERTY.test(property)) return false;
  const first = value.trim().split(',')[0].trim();
  if (NON_FAMILY_VALUE.test(first)) return false;
  // 不带引号的首项里出现关键字（swap、normal 900 …这类 font 简写）就不是字体栈
  if (!/^["']/.test(first) && first.split(/\s+/).some((word) => NON_FAMILY_KEYWORD.has(word.toLowerCase()))) return false;
  return true;
}

export function lintDesign(html, system, options = {}) {
  const declarations = pageDeclarations(html);
  const violations = [];
  const warnings = [];
  const notes = [];
  const usedColors = new Set();
  const usedFamilies = new Set();

  const colorTokens = (system?.colors ?? [])
    .map((entry) => ({ ...entry, color: parseColor(entry.value) }))
    .filter((entry) => entry.color);
  const allowedColors = new Set(colorTokens.map((entry) => colorKey(entry.color)));
  const allowedRgb = new Set(colorTokens.map((entry) => rgbKey(entry.color)));
  const fontStacks = (system?.fonts ?? []).map((entry) => ({ ...entry, families: splitFamilies(entry.value).map(normalizeFamily) }));
  const allowedFamilies = new Set(fontStacks.flatMap((entry) => entry.families));
  const spacingTokens = (system?.spacing ?? [])
    .map((entry) => ({ ...entry, px: lengthPx(entry.value) }))
    .filter((entry) => entry.px !== null);
  const allowedSpacing = new Set(spacingTokens.map((entry) => entry.px));

  const checkColors = colorTokens.length > 0;
  const checkFonts = fontStacks.length > 0;
  const checkSpacing = Boolean(options.spacing) && spacingTokens.length > 0;

  if (!system) notes.push('No design system given: ran generic checks only (palette size, font families, literal colors outside custom properties). Pass a design-system file to check tokens.');
  else {
    if (!checkColors) notes.push('The design system lists no colors: color tokens not checked.');
    if (!checkFonts) notes.push('The design system lists no fonts: font families not checked.');
    if (options.spacing && spacingTokens.length === 0) notes.push('The design system lists no spacing in px/rem: spacing not checked.');
  }

  for (const decl of declarations) {
    const line = lineAt(html, decl.offset);
    const isCustomProperty = decl.property.startsWith('--');
    for (const found of findColors(decl.value)) {
      const key = colorKey(found.color);
      usedColors.add(key);
      if (checkColors) {
        if (allowedColors.has(key) || allowedRgb.has(rgbKey(found.color))) continue;
        violations.push({ kind: 'color', line, property: decl.property, value: found.text, suggestion: nearestColor(found.color, colorTokens) });
      } else if (!isCustomProperty && decl.where !== 'attribute') {
        warnings.push({ kind: 'color', line, property: decl.property, value: found.text, suggestion: 'define it once as a CSS custom property and use var()' });
      }
    }

    let families = null;
    if (decl.property === 'font-family' || isFontStackProperty(decl.property, decl.value)) families = /var\(/.test(decl.value) ? null : decl.value;
    else if (decl.property === 'font') families = familiesFromFontShorthand(decl.value);
    if (families) {
      const primary = splitFamilies(families).map(normalizeFamily).find((family) => !GENERIC_FAMILIES.has(family));
      if (primary) {
        usedFamilies.add(primary);
        if (checkFonts && !allowedFamilies.has(primary)) {
          const suggestion = fontStacks[0] ? `${fontStacks[0].token} (${fontStacks[0].value})` : null;
          violations.push({ kind: 'font', line, property: decl.property, value: splitFamilies(families)[0], suggestion });
        }
      }
    }

    if (checkSpacing && SPACING_PROPERTIES.test(decl.property) && !/var\(|calc\(/.test(decl.value)) {
      for (const part of decl.value.split(/\s+/)) {
        const px = lengthPx(part);
        if (px === null || allowedSpacing.has(px)) continue;
        violations.push({ kind: 'spacing', line, property: decl.property, value: part, suggestion: nearestLength(px, spacingTokens) });
      }
    }
  }

  if (!system) {
    if (usedColors.size > 12) warnings.push({ kind: 'palette', line: 0, property: '', value: `${usedColors.size} distinct colors`, suggestion: 'consolidate into a smaller set of color roles' });
    if (usedFamilies.size > 3) warnings.push({ kind: 'fonts', line: 0, property: '', value: `${usedFamilies.size} primary font families`, suggestion: 'keep to a display and a body family (plus mono if needed)' });
  }
  return { violations, warnings, notes, stats: { declarations: declarations.length, colors: usedColors.size, families: usedFamilies.size } };
}

function formatFinding(file, finding, label) {
  const where = finding.line ? `${file}:${finding.line}` : file;
  const property = finding.property ? ` ${finding.property}:` : '';
  const hint = finding.suggestion ? ` -> ${label}: ${finding.suggestion}` : '';
  return `${where} [${finding.kind}]${property} ${finding.value}${hint}`;
}

async function main(argv) {
  const args = argv.filter((arg) => !arg.startsWith('--'));
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  if (args.length < 1 || args.length > 2 || flags.has('--help')) {
    console.error('Usage: node design-lint.mjs <page.html> [<design-system.md|.json>] [--spacing] [--json]');
    return 2;
  }
  const [pagePath, systemPath] = args;
  let html;
  try {
    html = readFileSync(pagePath, 'utf8');
  } catch (error) {
    console.error(`Cannot read ${pagePath}: ${error.message}`);
    return 2;
  }
  // Generic checks only when no system was given; an explicit path that cannot be read is a read error,
  // otherwise a typo would let token violations pass with exit 0.
  let system = null;
  if (systemPath) {
    let text;
    try {
      text = readFileSync(systemPath, 'utf8');
    } catch (error) {
      console.error(`Cannot read design system ${systemPath}: ${error.message}`);
      return 2;
    }
    try {
      system = parseDesignSystem(text, systemPath);
    } catch (error) {
      console.error(`Cannot parse ${systemPath}: ${error.message}`);
      return 2;
    }
    // A readable file with no tokens (empty, a README, no Colors/Fonts/Spacing/Radii section, JSON without those
    // keys) is not a design system; linting against it would check nothing and still exit 0.
    if (!['colors', 'fonts', 'spacing', 'radii'].some((section) => system[section].length > 0)) {
      console.error(`Not a design system: ${systemPath} has no tokens under Colors, Fonts, Spacing or Radii.`);
      return 2;
    }
  }
  const result = lintDesign(html, system, { spacing: flags.has('--spacing') });
  if (flags.has('--json')) {
    console.log(JSON.stringify({ file: pagePath, system: systemPath ?? null, ...result }, null, 2));
  } else {
    for (const note of result.notes) console.log(`note: ${note}`);
    for (const finding of result.violations) console.log(formatFinding(pagePath, finding, 'nearest token'));
    for (const finding of result.warnings) console.log(`warning: ${formatFinding(pagePath, finding, 'fix')}`);
    console.log(`${result.violations.length} violation(s), ${result.warnings.length} warning(s); ${result.stats.colors} distinct colors, ${result.stats.families} font families.`);
  }
  return result.violations.length > 0 ? 1 : 0;
}

const entry = process.argv[1] === undefined ? undefined : await realpath(process.argv[1]).catch(() => undefined);
if (entry !== undefined && entry === (await realpath(fileURLToPath(import.meta.url)))) process.exitCode = await main(process.argv.slice(2));
