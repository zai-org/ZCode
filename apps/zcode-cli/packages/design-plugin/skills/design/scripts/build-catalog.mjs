#!/usr/bin/env node
// Generates references/catalog.md and the skeleton block inside each deliverable file (deck / app / page)
// from design-resources/. Run: node scripts/build-catalog.mjs [--max-bytes=N] [--dir=references-dir]
// Facts tied to resource names live in CONFIG; tests/design/catalog.test.ts keeps it in sync with the files.
// Sections: CONFIG · resources · text helpers · catalog · skeleton blocks · main
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontmatter, splitFrontmatter } from "./frontmatter.mjs";

// Byte cap per generated target; the deliverable files also carry hand-written rules, so their cap is the whole file.
export const TARGETS = {
  catalog: { file: "catalog.md", maxBytes: 6144 },
  deck: { file: "deck.md", maxBytes: 6144 },
  app: { file: "app.md", maxBytes: 5120 },
  page: { file: "page.md", maxBytes: 5120 },
};

export const TRACKS = ["deck", "app", "page"];

export const CONFIG = {
  // One default skeleton per deliverable track, printed in that track's file.

  // Skeletons kept on disk but never offered: their mandatory steps need the Open Design daemon, connectors or a
  // media runtime (OD_* wrappers, artifact registration, MP4 generation) that this host does not provide, so no
  // static workflow can follow them as written.
  excludeSkeletons: ["live-artifact", "live-dashboard", "hyperframes", "video-shortform"],

  // Every skeleton not in excludeSkeletons belongs to exactly one category, and every category to one deliverable track;
  // list order is priority order (former Top before Standard).
  categories: [
    {
      key: "deck",
      track: "deck",
      title: "Deck — specific need (match one to one first)",
      craft: [],
      members: [
        "html-ppt-pitch-deck", "html-ppt-hermes-cyber-terminal", "html-ppt-taste-brutalist", "html-ppt-course-module",
        "kami-deck", "open-design-landing-deck", "weekly-update", "ib-pitch-book",
      ],
    },
    {
      key: "zhangzara",
      track: "deck",
      title: "Deck — zhangzara family, all `self` (`html-ppt-zhangzara-<x>`; pick by mood, then use)",
      prefix: "html-ppt-zhangzara-",
      craft: [],
      members: [
        "broadside", "bold-poster", "cartesian", "coral", "editorial-tri-tone", "neo-grid-bold", "peoples-platform",
        "pin-and-paper", "soft-editorial", "stencil-tablet", "retro-windows", "retro-zine", "sakura-chroma",
        "pink-script", "8-bit-orbit", "creative-mode", "daisy-days", "biennale-yellow", "block-frame", "capsule",
        "grove", "mat", "monochrome", "playful", "raw-grid", "signal", "studio", "vellum",
      ].map((x) => `html-ppt-zhangzara-${x}`),
    },
    {
      key: "dashboard",
      track: "page",
      title: "Dashboard",
      craft: ["state-coverage"],
      members: ["dashboard", "trading-analysis-dashboard-template", "ai-assistant-mobile-dashboard"],
    },
    {
      key: "web",
      track: "page",
      title: "Web page",
      craft: [],
      members: [
        "web-prototype", "web-prototype-taste-soft", "web-prototype-taste-editorial", "web-prototype-taste-brutalist",
        "saas-landing", "kami-landing", "pricing-page",
      ],
    },
    {
      key: "app",
      track: "app",
      title: "App",
      craft: ["state-coverage"],
      members: ["mobile-app", "kanban-board", "meeting-notes", "gamified-app", "wireframe-sketch"],
    },
    {
      key: "document",
      track: "page",
      title: "Document / report",
      craft: ["typography-hierarchy"],
      members: [
        "blog-post", "docs-page", "digital-eguide", "finance-report", "dcf-valuation", "clinical-case-report",
        "eng-runbook", "pm-spec", "hr-onboarding", "invoice", "magazine-poster",
      ],
    },
    {
      key: "media",
      track: "page",
      title: "Media / motion",
      craft: ["animation-discipline"],
      members: ["motion-frames", "sprite-animation", "social-carousel"],
    },
    {
      key: "utility",
      track: "page",
      title: "Utility",
      craft: [],
      members: ["critique", "tweaks", "orbit-linear", "orbit-notion", "x-research"],
    },
  ],

  // Rows whose name says enough.
  nameOnly: [
    "weekly-update", "ib-pitch-book", "dashboard", "trading-analysis-dashboard-template", "saas-landing", "pricing-page",
    "mobile-app", "kanban-board", "meeting-notes", "wireframe-sketch", "blog-post", "docs-page", "digital-eguide",
    "finance-report", "dcf-valuation", "clinical-case-report", "eng-runbook", "pm-spec", "hr-onboarding", "invoice",
    "magazine-poster", "motion-frames", "sprite-animation", "social-carousel",
  ],

  // One-line text replacing the description's first sentence.
  override: {
    // YAML ends the description at " #0a0c10", so the parsed text stops at "deck —".
    "html-ppt-hermes-cyber-terminal": "Dark terminal deck for CLI / agent / dev-tool reviews",
    "kami-deck": "Print-grade kami deck: parchment, ink-blue, one serif",
    "kami-landing": "Print-grade kami one-pager or white paper",
    "open-design-landing-deck": "Atelier Zero brand deck: warm paper, collage plates",
    "web-prototype": "General responsive web page",
    critique: "5-dimension expert review of an HTML artifact",
    tweaks: "Side panel of live CSS controls to compare variants",
    "orbit-linear": "Daily digest from Linear data",
    "orbit-notion": "Daily digest from Notion data",
    "x-research": "X/Twitter sentiment research; Markdown first is fine",
  },

  // Warnings shown under the category of their first resource.
  notes: [
    {
      names: ["open-design-landing-deck"],
      text: "`scripts/compose.ts` needs sibling CSS and images that are not shipped; build from the skill, example, inputs and `schema.ts`, do not run it",
    },
  ],

  // Files that some SKILL.md files name but the package does not ship (paths under design-resources/).
  // `label` joins the shared warning at the end of the track's block. `inline` instead rides on its own
  // skeleton's row, for a skeleton whose own text would otherwise make it stop or pretend it read them:
  // only a task that picks that skeleton pays for the caveat.
  missing: [
    {
      label: "the main html-ppt skill and `full-decks.md`",
      usedBy: ["html-ppt-pitch-deck", "html-ppt-course-module", "html-ppt-hermes-cyber-terminal"],
      paths: ["design-skeletons/html-ppt/SKILL.md", "design-skeletons/html-ppt/references/full-decks.md", "skills/html-ppt"],
    },
    {
      label: "the `open-design-landing` CSS and images",
      usedBy: ["open-design-landing-deck"],
      paths: ["design-skeletons/open-design-landing/styles.css", "design-skeletons/open-design-landing/assets"],
    },
    {
      usedBy: ["ai-assistant-mobile-dashboard"],
      paths: [
        "skills/design-core-rules/references/OUTPUT_RULES.md",
        "skills/design-core-rules/references/DESIGN.md",
        "审美相关skill/design-systems",
      ],
      inline:
        "the rule files, resource paths and in-app preview it cites are not shipped: ignore them and its abort-if-unread rule, never claim you read them, follow [create](create.md) and [check](check.md)",
    },
  ],

  // Skill SKILL.md files whose name differs from their directory.
  nameMismatch: ["infinite-canvas"],

  skills: {
    // gstack method skills: not offered for selection and not read by default.
    exclude: ["design-consultation", "design-review", "plan-design-review"],
    override: {
      "brand-guidelines": "Anthropic's own brand, only when the task asks for it",
      "frontend-design": "production-grade frontend UI",
      "frontend-slides": "animation-rich HTML slides",
      "infinite-canvas": "infinite-canvas delivery (`scripts/adapt-canvas.mjs`)",
      "taste-skill": "anti-slop tuning: density, motion, variance",
    },
  },

  // DESIGN.md `> Category:` value -> catalog group (group order = render order).
  systemGroups: {
    "Productivity & SaaS": "Tech / SaaS",
    "Developer Tools": "Tech / SaaS",
    "Design & Creative": "Tech / SaaS",
    "Themed & Unique": "Tech / SaaS",
    "Professional & Corporate": "Tech / SaaS",
    "Media & Consumer": "Tech / SaaS",
    "E-Commerce & Retail": "Tech / SaaS",
    "Bold & Expressive": "Style",
    "Creative & Artistic": "Style",
    "Morphism & Effects": "Style",
    "Layout & Structure": "Style",
    "Editorial & Print": "Editorial",
    "Editorial · Studio": "Editorial",
    "Fintech & Crypto": "Fintech",
    Automotive: "Automotive",
  },
  systemNotes: { kami: "only via kami-* skeletons" },
  // Short descriptions for systems without an Agent Prompt Guide (brand systems are listed by name).
  systemOverride: {
    agentic: "AI-first, delegated task flows",
    application: "purple app dashboard, top nav",
    arc: "translucent, sidebar-first",
    artistic: "expressive type, bold color",
    bento: "modular card grid",
    bold: "heavy type, high contrast",
    brutalism: "raw anti-design",
    glassmorphism: "frosted translucent layers",
  },

  // craft/<name>.md -> when to read. Key set must equal the craft/ directory.
  craft: {
    typography: "baseline, always",
    color: "baseline, always",
    "anti-ai-slop": "baseline, always",
    "accessibility-baseline": "baseline, always",
    "state-coverage": "apps, dashboards: loading/empty/error",
    "typography-hierarchy": "text-heavy pages",
    "typography-hierarchy-editorial": "content sites, magazine style",
    "animation-discipline": "any motion; read with [references/motion.md](motion.md), which wins where the two differ",
    "form-validation": "forms",
    "laws-of-ux": "highly interactive UI",
    "rtl-and-bidi": "Arabic/Hebrew only, even if a skeleton lists it",
  },
  craftBaseline: ["typography", "color", "anti-ai-slop", "accessibility-baseline"],
  craftAlias: { "motion-discipline": "animation-discipline" },
  craftDrop: ["typographic-rhythm", "pixel-discipline"],
  craftConditional: ["rtl-and-bidi"],

  // Triggers shared by the whole zhangzara family carry no routing signal.
  stopTriggers: ["html deck", "html slides", "zhangzara"],

  textWidth: 52,
  shortTextWidth: 40,
};

// ---------- resources ----------

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function subdirsWith(dir, file) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, file)))
    .map((entry) => entry.name)
    .sort(byCodePoint);
}

function readFrontmatter(file) {
  const raw = splitFrontmatter(readFileSync(file, "utf8"));
  if (raw === null) throw new Error(`missing frontmatter: ${file}`);
  return parseFrontmatter(raw);
}

// DESIGN.md has no frontmatter: `# Title`, then `> Category: X` and a quoted one-liner.
export function parseDesignSystem(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  const quote = [];
  while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, "").trim());
  const category = quote[0]?.match(/^Category:\s*(.+)$/)?.[1];
  if (!category) throw new Error("DESIGN.md lacks a `> Category:` line");
  return {
    category,
    description: quote.slice(1).join(" ").replace(/\s+/g, " ").trim(),
    full: text.includes("Agent Prompt Guide"),
  };
}

export function collectResources(resourceRoot) {
  const skeletonDir = join(resourceRoot, "design-skeletons");
  const skillDir = join(resourceRoot, "skills");
  const systemDir = join(resourceRoot, "design-systems");
  const skeletons = new Map();
  for (const name of subdirsWith(skeletonDir, "SKILL.md")) {
    skeletons.set(name, {
      frontmatter: readFrontmatter(join(skeletonDir, name, "SKILL.md")),
      hasExample: existsSync(join(skeletonDir, name, "example.html")),
    });
  }
  const skills = new Map();
  for (const name of subdirsWith(skillDir, "SKILL.md")) {
    skills.set(name, { frontmatter: readFrontmatter(join(skillDir, name, "SKILL.md")) });
  }
  const systems = new Map();
  for (const name of subdirsWith(systemDir, "DESIGN.md")) {
    systems.set(name, parseDesignSystem(readFileSync(join(systemDir, name, "DESIGN.md"), "utf8")));
  }
  const craft = readdirSync(join(resourceRoot, "craft"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .sort(byCodePoint);
  return { skeletons, skills, systems, craft };
}

// ---------- text helpers ----------

export function firstSentence(description) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  const end = /[。！？]|[.!?]["”']?(?=\s|$)/g;
  let match;
  while ((match = end.exec(text))) {
    const before = text.slice(0, match.index);
    if (match[0] === "." && /\b(?:e\.g|i\.e|vs|etc)$/i.test(before)) continue;
    return before.trim();
  }
  return text;
}

const charWidth = (ch) => (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1);
const width = (s) => [...s].reduce((n, ch) => n + charWidth(ch), 0);

// Shorten to `max` display columns, preferring the part before " — " when it can stand alone.
export function clip(text, max) {
  let s = text.replace(/\*\*/g, "").replace(/["“”]/g, "").trim();
  const dash = s.indexOf(" — ");
  if (dash >= 0 && width(s.slice(0, dash)) >= 20) s = s.slice(0, dash);
  s = s.replace(/^An? (?=[a-z])/, "");
  if (width(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    if (w + charWidth(ch) > max - 1) break;
    out += ch;
    w += charWidth(ch);
  }
  const atWord = out.replace(/[\s,;:/(—–-]+[^\s,;:/(—–-]*$/, "");
  return `${(width(atWord) > max / 2 ? atWord : out).replace(/[\s,;:/(—–-]+$/, "")}…`;
}

export function resolveCraft(name) {
  if (CONFIG.craftDrop.includes(name)) return null;
  return CONFIG.craftAlias[name] ?? name;
}

function craftExtras(frontmatter, groupCraft) {
  const extras = [];
  for (const declared of frontmatter.od?.craft?.requires ?? []) {
    const name = resolveCraft(declared);
    if (!name || CONFIG.craftBaseline.includes(name) || CONFIG.craftConditional.includes(name)) continue;
    if (groupCraft.includes(name) || extras.includes(name)) continue;
    extras.push(name);
  }
  return extras;
}

function zhangzaraText(name, frontmatter, prefix) {
  const short = name.slice(prefix.length);
  const triggers = (frontmatter.triggers ?? []).filter(
    (t) =>
      !CONFIG.stopTriggers.includes(t) &&
      !t.startsWith("zhangzara-") &&
      !/^[A-Z]/.test(t) &&
      t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") !== short,
  );
  const moods = triggers.filter((t) => !/[ /]/.test(t)).slice(0, 3);
  const use = triggers.find((t) => /[ /]/.test(t));
  return [moods.join(", "), use].filter(Boolean).join(" · ");
}

const code = (name) => `\`${name}\``;

// ---------- catalog ----------

export function indexResources(resourceRoot) {
  const resources = collectResources(resourceRoot);
  const categoryOf = new Map();
  for (const name of CONFIG.excludeSkeletons) {
    if (!resources.skeletons.has(name)) throw new Error(`excludeSkeletons lists unknown skeleton ${name}`);
  }
  for (const category of CONFIG.categories) {
    if (!TRACKS.includes(category.track)) throw new Error(`category ${category.key} has unknown track ${category.track}`);
    for (const name of category.members) {
      if (!resources.skeletons.has(name)) throw new Error(`category ${category.key} lists unknown skeleton ${name}`);
      if (categoryOf.has(name)) throw new Error(`skeleton ${name} is in two categories`);
      if (CONFIG.excludeSkeletons.includes(name)) throw new Error(`skeleton ${name} is excluded but listed in ${category.key}`);
      categoryOf.set(name, category);
    }
  }
  const unassigned = [...resources.skeletons.keys()].filter(
    (name) => !categoryOf.has(name) && !CONFIG.excludeSkeletons.includes(name),
  );
  if (unassigned.length) throw new Error(`skeletons without a category: ${unassigned.join(", ")}`);
  const craftKeys = Object.keys(CONFIG.craft).sort(byCodePoint);
  if (craftKeys.join() !== resources.craft.join()) throw new Error("CONFIG.craft keys differ from the craft/ directory");
  return { ...resources, categoryOf };
}

// The shared half of the catalog: design systems, specialist skills, craft. Skeletons live in the deliverable files.
export function buildCatalog(resourceRoot) {
  const { skills, systems } = indexResources(resourceRoot);
  const body = [];

  body.push("## Skills", "`design-resources/skills/<name>/SKILL.md`; only when no skeleton fits.", "");
  for (const [name, { frontmatter }] of skills) {
    if (CONFIG.skills.exclude.includes(name)) continue;
    const text = CONFIG.skills.override[name] ?? clip(firstSentence(frontmatter.description), CONFIG.shortTextWidth);
    body.push(`- ${code(name)} — ${text}`);
  }
  body.push("");

  body.push(
    "## Design systems",
    "`design-resources/design-systems/<name>/DESIGN.md`; read the file, not this line. With a brand system also read [BRAND-DISCLAIMER.md](../design-resources/design-systems/BRAND-DISCLAIMER.md).",
    "",
  );
  const groups = new Map([...new Set(Object.values(CONFIG.systemGroups))].map((group) => [group, []]));
  for (const [name, system] of systems) {
    const group = CONFIG.systemGroups[system.category];
    if (!group) throw new Error(`design system ${name}: unknown category ${system.category}`);
    let entry = code(name);
    if (CONFIG.systemNotes[name]) entry += ` (${CONFIG.systemNotes[name]})`;
    else if (CONFIG.systemOverride[name]) entry += ` ${CONFIG.systemOverride[name]}`;
    else if (!system.full) entry += ` ${clip(firstSentence(system.description), CONFIG.shortTextWidth)}`;
    groups.get(group).push(entry);
  }
  for (const [group, entries] of groups) {
    if (entries.length) body.push(`- **${group}**: ${entries.join("; ")}`);
  }
  body.push("");

  const aliases = Object.entries(CONFIG.craftAlias).map(([from, to]) => `${code(from)} = ${code(to)}`);
  body.push(
    "## Craft",
    `\`design-resources/craft/<name>.md\`. Metadata names: ${aliases.join("; ")}; ${CONFIG.craftDrop.map(code).join(", ")} are not shipped.`,
    "",
  );
  const byWhen = new Map();
  for (const [name, when] of Object.entries(CONFIG.craft)) byWhen.set(when, [...(byWhen.get(when) ?? []), name]);
  for (const [when, names] of byWhen) body.push(`- ${names.map(code).join(", ")} — ${when}`);

  const tracks = TRACKS.map((track) => `${track} in [${track}](${track}.md)`).join(", ");
  const head = [
    "# Resource catalog",
    "",
    "<!-- Generated by scripts/build-catalog.mjs from design-resources/; do not edit. -->",
    "",
    `The resources every deliverable shares. Paths are relative to this skill's directory; skeletons are listed per deliverable, ${tracks}.`,
    "Pick one skeleton (a skill only if none fits), read it, then a design system and craft; never bulk-read.",
    "Skeleton row flags: `self` = own visual rules, no design system needed; `+x` = extra craft; `ds:` = brand systems that skeleton suggests; `no example` = nothing beside it to open. Craft = baseline + the row's group default + its `+x`.",
    "",
  ];
  return `${[...head, ...body].join("\n").replace(/\n+$/, "")}\n`;
}

// ---------- skeleton blocks ----------

export const BLOCK_BEGIN = "<!-- Skeletons generated by scripts/build-catalog.mjs; do not edit this block by hand. -->";
export const BLOCK_END = "<!-- End of generated skeletons. -->";

// The skeleton shortlist for one deliverable track, as it appears between the markers in that track's file.
export function buildSkeletonBlock(resourceRoot, track) {
  const { skeletons, categoryOf } = indexResources(resourceRoot);
  if (!TRACKS.includes(track)) throw new Error(`unknown track ${track}`);
  const body = [
    `\`design-resources/design-skeletons/<name>/SKILL.md\`; row flags are defined in [catalog](catalog.md). Folders not listed need a runtime this host lacks; never use them.`,
    "",
  ];
  for (const category of CONFIG.categories.filter((c) => c.track === track)) {
    body.push(`### ${category.title}${category.craft.length ? ` (+${category.craft.join(", ")})` : ""}`);
    for (const name of category.members) {
      const { frontmatter, hasExample } = skeletons.get(name);
      const flags = [];
      const extras = craftExtras(frontmatter, category.craft);
      if (extras.length) flags.push(`+${extras.join(", ")}`);
      if (!category.prefix && frontmatter.od?.design_system?.requires === false) flags.push("self");
      const brands = frontmatter.od?.design_system?.recommended_brands;
      if (brands?.length) flags.push(`ds: ${brands.slice(0, 3).join("/")}`);
      if (!hasExample) flags.push("no example");
      let text;
      if (category.prefix) text = zhangzaraText(name, frontmatter, category.prefix);
      else if (CONFIG.override[name]) text = CONFIG.override[name];
      else if (!CONFIG.nameOnly.includes(name)) text = clip(firstSentence(frontmatter.description), CONFIG.textWidth);
      // Kept ahead of the flags so every row still ends in its `[...]`.
      const caveat = CONFIG.missing.find((entry) => entry.inline && entry.usedBy.includes(name))?.inline;
      if (caveat) text = text ? `${text}; ${caveat}` : caveat;
      const label = category.prefix ? name.slice(category.prefix.length) : name;
      body.push(`- ${code(label)}${text ? ` — ${text}` : ""}${flags.length ? ` [${flags.join("; ")}]` : ""}`);
    }
    for (const note of CONFIG.notes) {
      if (categoryOf.get(note.names[0]) === category) body.push(`- Note, ${note.names.map(code).join(", ")}: ${note.text}.`);
    }
    body.push("");
  }
  const missing = CONFIG.missing.filter((entry) => entry.label && categoryOf.get(entry.usedBy[0]).track === track);
  if (missing.length) {
    body.push(`Not shipped, though some SKILL.md files name them: ${missing.map((entry) => entry.label).join("; ")}. Do not claim to have read or run them.`);
  }
  return body.join("\n").replace(/\n+$/, "");
}

// Replaces the generated block in a deliverable file, leaving its hand-written rules alone.
export function patchSkeletonBlock(text, block) {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start < 0 || end < 0 || end < start) throw new Error(`file lacks the ${BLOCK_BEGIN} / ${BLOCK_END} markers`);
  return `${text.slice(0, start)}${BLOCK_BEGIN}\n\n${block}\n\n${text.slice(end)}`;
}

// Every generated file as it should be on disk, read from and keyed by its path under `referencesDir`.
export function buildAll(resourceRoot, referencesDir) {
  const out = new Map();
  out.set(TARGETS.catalog.file, buildCatalog(resourceRoot));
  for (const track of TRACKS) {
    const file = TARGETS[track].file;
    const current = readFileSync(join(referencesDir, file), "utf8");
    out.set(file, patchSkeletonBlock(current, buildSkeletonBlock(resourceRoot, track)));
  }
  return out;
}

// Bytes per `##` / `###` section, for the over-cap report.
export function sectionSizes(text) {
  let current = { title: "(head)", bytes: 0 };
  const sizes = [current];
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const heading = line.match(/^#{2,3} (.+)$/);
    if (heading) sizes.push((current = { title: heading[1], bytes: 0 }));
    current.bytes += Buffer.byteLength(`${line}\n`, "utf8");
  }
  return sizes;
}

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function main(argv = process.argv.slice(2)) {
  const option = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const override = option("max-bytes") === undefined ? null : Number(option("max-bytes"));
  const dir = option("dir") ?? join(skillRoot, "references");
  const texts = buildAll(join(skillRoot, "design-resources"), dir);
  const capOf = (file) => override ?? Object.values(TARGETS).find((t) => t.file === file).maxBytes;
  const over = [...texts].filter(([file, text]) => Buffer.byteLength(text, "utf8") > capOf(file));
  // All or nothing: an over-cap file would otherwise be committed while its siblings look fresh.
  if (over.length) {
    for (const [file, text] of over) {
      const report = sectionSizes(text).map(({ title, bytes }) => `  ${String(bytes).padStart(6)}  ${title}`);
      process.stderr.write(`${file} is ${Buffer.byteLength(text, "utf8")} B, over the ${capOf(file)} B cap; not written.\n${report.join("\n")}\n`);
    }
    return 1;
  }
  for (const [file, text] of texts) {
    writeFileSync(join(dir, file), text);
    process.stdout.write(`wrote ${join(dir, file)}: ${Buffer.byteLength(text, "utf8")} B, ${text.split("\n").length - 1} lines\n`);
  }
  return 0;
}

// Compare real paths: import.meta.url is already symlink-resolved, so a run through a symlinked
// install path (or a symlinked /tmp) must not silently skip main(). Synthetic entry paths need not resolve.
function entryUrl(scriptPath) {
  if (scriptPath === undefined) return undefined;
  try {
    return pathToFileURL(realpathSync(resolve(scriptPath))).href;
  } catch {
    return undefined;
  }
}

if (import.meta.url === entryUrl(process.argv[1])) {
  process.exitCode = main();
}
