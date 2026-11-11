/* eslint-disable max-lines -- skill 发现 + 校验 + 状态 + 通用目录管理在同一服务里聚合，分层后跳转成本更高 */
import { access, appendFile, cp, mkdir, realpath, rm, readFile, readdir } from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ZCodeProvider,
  SkillDiagnostic,
  SkillMetadata,
  SkillScope,
  SkillSummary,
  SkillsPromptContext,
  SkillsListResult,
  SkillsCapability,
} from "@zcode/shared";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "@zcode/shared";
import type { ISkillsService } from "./skills.js";
import { SKILL_FILE_NAME, walkSkillMarkdownPaths } from "./skillDiscoveryWalk.js";
import { readInstalledPluginRoots } from "#src/plugins/installedPluginRoots.js";
import { updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";

interface DiscoverResult {
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  name: string;
  description: string;
  body: string;
  /** frontmatter 中出现过的顶层 key，保留给后续能力判断，不再作为 warning 暴露。 */
  keys: string[];
  /** 严格 YAML 解析是否成功；失败时仍可能有 looseFields。 */
  parseOk: boolean;
}

const SKILL_META_FILE_NAME = "_meta.json";
const SKILL_SETTINGS_DIR = join(resolveUserHomeDir(), ".zcode", "v2");
const SKILL_CLI_SETTINGS_DIR = join(resolveUserHomeDir(), ".zcode", "cli");
const SKILL_CLI_CONFIG_FILE = join(SKILL_CLI_SETTINGS_DIR, "config.json");
const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
const ZCODE_PLUGIN_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_PLUGIN_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_PLUGIN_MANIFEST_PATH = join(".codex-plugin", "plugin.json");

/** 对齐 apps/zcode-cli/packages/adapters/src/skills/index.ts:19 */
const MAX_DESCRIPTION_LENGTH = 1024;
function resolveUserHomeDir() {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

interface SkillsServiceOptions {
  isDesktopRuntime?: boolean;
}

/** ZCode Agent 工作区级技能目录。 */
function getWorkspaceZcodeSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "skills");
}

/** 兼容目录: workspace 级 `.agents/skills`, 仅在同层 `.zcode/skills` 没读到技能时 fallback。 */
function getWorkspaceAgentsSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".agents", "skills");
}

/** ZCode Agent 用户级技能目录。 */
function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

/** 兼容目录: 用户级 `~/.agents/skills`。 */
function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

async function readSkillNameKey(skillPath: string): Promise<string> {
  const fallbackName = basename(dirname(skillPath));
  try {
    const parsed = readFrontmatter(await readFile(skillPath, "utf-8"));
    const rawName = parsed.hasFrontmatter ? parsed.name.trim() : fallbackName;
    return normalizeSkillNameKey(rawName || fallbackName);
  } catch {
    return normalizeSkillNameKey(fallbackName);
  }
}

async function collectSkillNameKeysInRoot(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
  const diagnostics: SkillDiagnostic[] = [];
  for (const skillPath of await collectSkillMarkdownPaths(rootPath, diagnostics)) {
    nameKeys.add(await readSkillNameKey(skillPath));
  }
  return nameKeys;
}

async function isUserAgentsSkillCoveredByZcode(params: {
  skillPath: string;
  rootPath: string;
  userZcodeSkillNameKeys: Set<string>;
}): Promise<boolean> {
  const { skillPath, rootPath, userZcodeSkillNameKeys } = params;
  if (rootPath !== getUserAgentsSkillRoot()) {
    return false;
  }
  if (await exists(join(getUserZcodeSkillRoot(), basename(dirname(skillPath)), SKILL_FILE_NAME))) {
    return true;
  }
  return userZcodeSkillNameKeys.has(await readSkillNameKey(skillPath));
}

/**
 * 从 workspacePath 向上走到 worktree 根（含 .git 标记），把每一层的
 * `.zcode/skills` 与 `.agents/skills` 都收集起来。
 * 对齐 apps/zcode-cli/packages/adapters/src/skills/roots.ts:60-72。
 * 找不到 .git 时退回 workspacePath 自身。
 */
async function resolveAncestorWorkspaceRoots(workspacePath: string): Promise<string[]> {
  const worktreeRoot = await findWorktreeRoot(workspacePath);
  const baseDirectories: string[] = [];
  if (!worktreeRoot) {
    baseDirectories.push(workspacePath);
  } else {
    let current = workspacePath;
    while (true) {
      baseDirectories.push(current);
      if (current === worktreeRoot || current === dirname(current)) {
        break;
      }
      current = dirname(current);
    }
  }
  const roots: string[] = [];
  for (const dir of baseDirectories) {
    // Agent runtime 会合并扫描两个 workspace skill 根。UI 之前把 `.agents`
    // 当成 `.zcode` 的 fallback，导致同层 `.zcode` 只要有一个技能，`/`、`$` 和设置页
    // 就会整根漏掉 `.agents` 技能，形成“模型可执行但 UI 无法引用”的发现语义分裂。
    roots.push(getWorkspaceZcodeSkillRoot(dir));
    roots.push(getWorkspaceAgentsSkillRoot(dir));
  }
  return roots;
}

async function findWorktreeRoot(workingDirectory: string): Promise<string | null> {
  let current = workingDirectory;
  while (true) {
    if (await exists(join(current, GIT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function dedupeRoots(paths: string[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    roots.add(path);
  }
  return [...roots];
}

function normalizeScanRootPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * 去掉会被「已存在」的更深层扫描根完全覆盖的祖先目录。
 * 同一目录被不同路径形式扫到时，同一 SKILL.md 会因路径字符串不同重复出现。
 * 若子目录尚不存在，仍保留父目录以兼容非标准布局。
 */
async function filterNestedScanRoots(paths: string[]): Promise<string[]> {
  const existing = new Set<string>();
  for (const path of paths) {
    if (await exists(path)) {
      existing.add(normalizeScanRootPath(path));
    }
  }
  const normalized = paths.map((path) => normalizeScanRootPath(path));
  return paths.filter((path, index) => {
    const current = normalized[index] ?? normalizeScanRootPath(path);
    if (!existing.has(current)) {
      return true;
    }
    return !normalized.some((other, otherIndex) => {
      if (otherIndex === index || !existing.has(other)) {
        return false;
      }
      return other.startsWith(`${current}/`);
    });
  });
}

async function dedupeScanRootsByRealpath(paths: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    let canonical = normalizeScanRootPath(path);
    if (await exists(path)) {
      canonical = normalizeScanRootPath(await realpath(path).catch(() => path));
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    result.push(path);
  }
  return result;
}

function hashStableIdPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function buildSkillId(params: {
  provider: ZCodeProvider;
  scope: SkillScope;
  name: string;
  path: string;
}): string {
  return `${params.provider}:${params.scope}:${params.name}:${hashStableIdPart(params.path)}`;
}

function collectMentionedSkillNames(prompt: string): Set<string> {
  const names = new Set<string>();
  for (const match of prompt.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildActivatedSkillsPromptBlock(skills: SkillSummary[]): string {
  return [
    "<available_skills>",
    ...skills.map((skill) =>
      [
        `<activated_skill name="${escapeXmlAttribute(skill.name)}" path="${escapeXmlAttribute(skill.path)}">`,
        skill.body,
        "</activated_skill>",
      ].join("\n"),
    ),
    "</available_skills>",
  ].join("\n");
}

async function appendSkillsAuditLog(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activatedSkillNames: string[];
}): Promise<void> {
  await mkdir(SKILL_SETTINGS_DIR, { recursive: true });
  await appendFile(
    join(SKILL_SETTINGS_DIR, "skills-audit.log"),
    `${JSON.stringify({
      createdAt: Date.now(),
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? null,
      activatedSkillNames: params.activatedSkillNames,
    })}\n`,
    "utf-8",
  );
}

function readFrontmatter(content: string): ParsedFrontmatter {
  // SKILL.md 可能来自 Windows 或其他工具链，换行符不一定是 \n。
  // 先统一换行，再把 frontmatter 字段交给 YAML 解析，兼容多行 description。
  const normalized = content.replace(/\r\n|\r/g, "\n");
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!frontmatterMatch) {
    return {
      hasFrontmatter: false,
      name: "",
      description: "",
      body: normalized.trim(),
      keys: [],
      parseOk: false,
    };
  }

  const frontmatterText = frontmatterMatch[1] ?? "";
  const frontmatterParts = splitFrontmatterAndLeakedBody(frontmatterText);
  const bodyAfterFrontmatter = normalized.slice(frontmatterMatch[0].length).trim();
  const body = [frontmatterParts.leakedBody, bodyAfterFrontmatter]
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();
  const looseFields = readLooseFrontmatterFields(frontmatterParts.metadataText);
  const looseKeys = extractLooseFrontmatterKeys(frontmatterParts.metadataText);
  if (hasYamlUnsafeLooseInlineField(frontmatterParts.metadataText)) {
    // 历史中文 description 常写成未加引号的 `触发场景: ...`。
    // `: ` 在 YAML plain scalar 中会被当成映射分隔符，严格解析只会报错；这里直接采用宽松读取结果，避免全量并发测试里反复进入失败解析路径。
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterParts.metadataText);
  } catch {
    // 历史 skill 里存在 closing --- 前混入正文的非严格 YAML。
    // YAML 解析失败时回退到宽松字段读取，避免中文 description 等已存在 metadata 丢失。
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }
  if (!isObjectRecord(parsed)) {
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }

  return {
    hasFrontmatter: true,
    name: readFrontmatterString(parsed.name) || looseFields.name,
    description: readFrontmatterString(parsed.description) || looseFields.description,
    body,
    keys: Object.keys(parsed),
    parseOk: true,
  };
}

function splitFrontmatterAndLeakedBody(frontmatterText: string): {
  metadataText: string;
  leakedBody: string;
} {
  const lines = frontmatterText.split("\n");
  const leakedBodyStartIndex = lines.findIndex(
    (line, index) =>
      index > 0 &&
      // 部分历史 skill 把正文标题写在 closing --- 之前。
      // 遇到 Markdown 标题时，将这一段从 frontmatter 挪回 body，避免说明内容被解析阶段吞掉。
      /^#{1,6}\s+\S/.test(line),
  );
  if (leakedBodyStartIndex < 0) {
    return { metadataText: frontmatterText, leakedBody: "" };
  }
  return {
    metadataText: lines.slice(0, leakedBodyStartIndex).join("\n").trimEnd(),
    leakedBody: lines.slice(leakedBodyStartIndex).join("\n").trim(),
  };
}

function readLooseFrontmatterFields(frontmatterText: string): {
  name: string;
  description: string;
} {
  let name = "";
  let description = "";
  const lines = frontmatterText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (key === "name") {
      name = readLooseFrontmatterInlineString(rawValue);
    } else if (key === "description") {
      const blockStyle = rawValue[0];
      if (blockStyle === "|" || blockStyle === ">") {
        const blockLines: string[] = [];
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = lines[nextIndex] ?? "";
          if (!nextLine.startsWith(" ") && !nextLine.startsWith("\t")) {
            break;
          }
          blockLines.push(nextLine.replace(/^\s{1,2}/, ""));
          index = nextIndex;
        }
        description = blockStyle === ">" ? blockLines.join(" ") : blockLines.join("\n");
      } else {
        description = readLooseFrontmatterInlineString(rawValue);
      }
    }
  }
  return { name, description };
}

/**
 * 只收集 frontmatter 顶层 key（缩进行视为子字段，跳过）。
 * 用来给 unknown-key 诊断与 YAML 解析失败时的回退提供 keys 列表。
 */
function extractLooseFrontmatterKeys(frontmatterText: string): string[] {
  const keys: string[] = [];
  for (const line of frontmatterText.split("\n")) {
    if (line.length === 0) continue;
    if (/^\s/.test(line)) continue;
    if (line.trim().startsWith("#")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    if (key.length === 0) continue;
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function hasYamlUnsafeLooseInlineField(frontmatterText: string): boolean {
  const lines = frontmatterText.split("\n");
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    if (key !== "name" && key !== "description") {
      continue;
    }
    const rawValue = line.slice(colonIndex + 1).trim();
    if (
      rawValue.length === 0 ||
      rawValue.startsWith('"') ||
      rawValue.startsWith("'") ||
      rawValue.startsWith("|") ||
      rawValue.startsWith(">")
    ) {
      continue;
    }
    if (rawValue.includes(": ")) {
      return true;
    }
  }
  return false;
}

function readLooseFrontmatterInlineString(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function readFrontmatterString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

async function readSkillMetadata(skillPath: string): Promise<SkillMetadata | undefined> {
  const metaPath = join(dirname(skillPath), SKILL_META_FILE_NAME);
  const raw = await readFile(metaPath, "utf-8").catch(() => null);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      return undefined;
    }
    const metadata: SkillMetadata = {};
    if (typeof parsed.slug === "string" && parsed.slug.trim().length > 0) {
      metadata.slug = parsed.slug.trim();
    }
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      metadata.version = parsed.version.trim();
    }
    if (typeof parsed.ownerId === "string" && parsed.ownerId.trim().length > 0) {
      metadata.ownerId = parsed.ownerId.trim();
    }
    if (typeof parsed.publishedAt === "number" && Number.isFinite(parsed.publishedAt)) {
      metadata.publishedAt = parsed.publishedAt;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch {
    // _meta.json 是 skill 安装器的附加信息，损坏时不应影响 SKILL.md 本体展示。
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeSkillConfigPath(path: string): string {
  return path.replaceAll("\\", "/");
}

// 只用于列表展示：config.json 损坏时按空配置展示技能，不影响浏览。写入走 writeSkillEnabledMap。
async function readCliConfigFile(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(SKILL_CLI_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSkillEnabledMapFromConfig(config: Record<string, unknown>): Record<string, boolean> {
  const skillsConfig = isObjectRecord(config.skills) ? config.skills : {};
  const result: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(skillsConfig)) {
    if (isObjectRecord(value) && typeof value.enable === "boolean") {
      result[normalizeSkillConfigPath(path)] = value.enable;
    }
  }
  return result;
}

async function readSkillEnabledMap(): Promise<Record<string, boolean>> {
  return readSkillEnabledMapFromConfig(await readCliConfigFile());
}

/**
 * 根因：旧实现写入前用 readCliConfigFile 读取，读失败或 JSON 损坏时返回空对象，再用 writeFile
 * 整文件写回，config.json 里的 MCP、插件等其他配置会被冲掉；writeFile 也不是原子写。
 * 修法：改用 updateJsonObjectFile——文件损坏时报错不写，写前重读，只改 skills 字段，原子替换。
 */
async function writeSkillEnabledMap(next: Record<string, boolean>): Promise<void> {
  await updateJsonObjectFile(SKILL_CLI_CONFIG_FILE, (current) => {
    const config = { ...current };
    const skillsConfig = isObjectRecord(config.skills) ? { ...config.skills } : {};
    for (const [path, enable] of Object.entries(next).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      // 技能开关之前分散在 workspace/provider/context 状态文件，导致同一技能在不同入口表现不一致。
      // 现在只按 SKILL.md 路径写入 CLI config 的 skills 字段，避免额外迁移或旧文件副作用。
      const normalizedPath = normalizeSkillConfigPath(path);
      if (enable) {
        // 开启态是默认值，不应落盘成 `{ enable: true }`；删除 override 才能跟随插件/默认配置变化。
        delete skillsConfig[normalizedPath];
      } else {
        skillsConfig[normalizedPath] = { enable };
      }
    }
    if (Object.keys(skillsConfig).length > 0) {
      config.skills = skillsConfig;
    } else {
      delete config.skills;
    }
    return config;
  });
}

interface SkillRootDescriptor {
  scope: SkillScope;
  rootPath: string;
  pluginName?: string;
  pluginId?: string;
}

interface PluginConfigSummary {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  storageDir: string;
  suppressedBuiltins: string[];
}

interface PluginRootCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
}

interface PluginManifestSummary {
  name: string;
  skills?: unknown;
}

function readPluginConfigFromConfig(config: Record<string, unknown>): PluginConfigSummary {
  const plugins = isObjectRecord(config.plugins) ? config.plugins : {};
  return {
    dirs: readStringArray(plugins.dirs),
    enabled: typeof plugins.enabled === "boolean" ? plugins.enabled : true,
    enabledPlugins: readBooleanRecord(plugins.enabledPlugins),
    storageDir: readStorageDirFromConfig(config),
    suppressedBuiltins: readStringArray(plugins.suppressedBuiltins),
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readBooleanRecord(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!isObjectRecord(value)) {
    return result;
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") {
      result[key] = enabled;
    }
  }
  return result;
}

function readStorageDirFromConfig(config: Record<string, unknown>): string {
  const storage = isObjectRecord(config.storage) ? config.storage : {};
  return typeof storage.dir === "string" && storage.dir.trim().length > 0
    ? storage.dir
    : "~/.zcode";
}

function resolveConfigPath(path: string): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function resolveCliStorageRoot(storageDir: string): string {
  const storageRoot = resolveConfigPath(storageDir);
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

function resolvePluginStorageRoot(storageDir: string): string {
  return join(resolveCliStorageRoot(storageDir), "plugins");
}

function parsePathList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return readStringArray(value);
}

function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) {
    return null;
  }
  const resolved = resolve(rootPath, rawPath);
  const relativePath = relative(rootPath, resolved);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`))
  ) {
    return resolved;
  }
  return null;
}

async function scanOfficialPluginCacheRoots(pluginStorageRoot: string): Promise<string[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries: Dirent[] = [];
  try {
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: string[] = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) {
      continue;
    }
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries: Dirent[] = [];
    try {
      versionEntries = await readdir(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const versionEntry of versionEntries) {
      if (versionEntry.isDirectory()) {
        roots.push(join(pluginDir, versionEntry.name));
      }
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

async function readPluginManifest(rootPath: string): Promise<PluginManifestSummary | null> {
  const manifestPath = await findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
      return null;
    }
    return { name, skills: parsed.skills };
  } catch {
    return null;
  }
}

async function findPluginManifestPath(rootPath: string): Promise<string | null> {
  for (const manifestPath of [
    join(rootPath, ZCODE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CLAUDE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CODEX_PLUGIN_MANIFEST_PATH),
  ]) {
    if (await exists(manifestPath)) {
      return manifestPath;
    }
  }
  return null;
}

function resolvePluginSkillRoots(params: {
  manifest: PluginManifestSummary;
  rootPath: string;
}): string[] {
  const roots: string[] = [];
  for (const rawPath of parsePathList(params.manifest.skills)) {
    const rootPath = resolveInside(params.rootPath, rawPath);
    if (rootPath) {
      roots.push(rootPath);
    }
  }
  if (roots.length === 0 && params.manifest.skills === undefined) {
    const defaultRoot = join(params.rootPath, "skills");
    if (existsSync(defaultRoot)) {
      roots.push(defaultRoot);
    }
  }
  return roots;
}

async function resolvePluginSkillRootDescriptors(): Promise<SkillRootDescriptor[]> {
  const config = readPluginConfigFromConfig(await readCliConfigFile());
  if (!config.enabled) {
    return [];
  }

  const pluginStorageRoot = resolvePluginStorageRoot(config.storageDir);
  const officialCacheRoots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
  const installedRoots = await readInstalledPluginRoots(pluginStorageRoot);
  const candidates: PluginRootCandidate[] = [
    ...config.dirs.map((dir) => ({
      defaultEnabled: true,
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      rootPath: resolveConfigPath(dir),
    })),
    ...officialCacheRoots.map((rootPath) => ({
      defaultEnabled: false,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath,
    })),
    ...installedRoots,
  ];
  const descriptors: SkillRootDescriptor[] = [];
  const seenPluginIds = new Set<string>();

  for (const candidate of candidates) {
    const manifest = await readPluginManifest(candidate.rootPath);
    if (!manifest) {
      continue;
    }
    const pluginId = `${manifest.name}@${candidate.marketplace}`;
    // 内置官方插件被「卸载」后只在 CLI config 写入 suppressedBuiltins；desktop 直接扫
    // 官方 cache 时不经过 CLI resolve 的过滤，需要在这里同样跳过，否则被卸载的内置插件
    // 仍会从 cache 贡献技能。
    if (
      candidate.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      config.suppressedBuiltins.includes(pluginId)
    ) {
      continue;
    }
    if (seenPluginIds.has(pluginId)) {
      continue;
    }
    seenPluginIds.add(pluginId);
    const defaultEnabled =
      candidate.defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId);
    const enabled = config.enabledPlugins[pluginId] ?? defaultEnabled;
    if (!enabled) {
      continue;
    }
    // agent runtime 已经从 plugin manifest 注入 skillRoots，但 UI 的 skillsService
    // 之前只扫描内置官方 cache/手动目录，漏掉 marketplace installed_plugins.json 中的
    // 个人来源市场（claude-plugins-official、自建市场等）插件，导致插件详情页只有技能数量、没有技能名。
    for (const rootPath of resolvePluginSkillRoots({ manifest, rootPath: candidate.rootPath })) {
      descriptors.push({
        scope: "plugin",
        rootPath,
        pluginName: manifest.name,
        pluginId,
      });
    }
  }

  return descriptors;
}

async function discoverSkills(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  includeUserSkills: boolean;
  provider: ZCodeProvider;
}): Promise<DiscoverResult> {
  const workspaceRoots = dedupeRoots(await resolveAncestorWorkspaceRoots(params.workspacePath));
  const roots: SkillRootDescriptor[] = workspaceRoots.map((rootPath) => ({
    scope: "workspace" as const,
    rootPath,
  }));
  if (params.includeUserSkills) {
    // 用户级技能是全局资源，`.zcode/skills` 里只要存在一个技能就截断
    // `.agents/skills` 会导致外部 Agent 的全局技能在导入后从设置页消失。
    roots.push({
      scope: "user" as const,
      rootPath: getUserZcodeSkillRoot(),
    });
    roots.push({
      scope: "user" as const,
      rootPath: getUserAgentsSkillRoot(),
    });
  }
  roots.push(...(await resolvePluginSkillRootDescriptors()));

  const diagnostics: SkillDiagnostic[] = [];
  const skills: SkillSummary[] = [];
  const seenSkillPaths = new Set<string>();
  const userZcodeSkillNameKeys = params.includeUserSkills
    ? await collectSkillNameKeysInRoot(getUserZcodeSkillRoot())
    : new Set<string>();
  // 插件的父、子声明都是独立入口，不能按递归覆盖关系裁掉父入口。
  const standaloneRoots = await filterNestedScanRoots(
    roots.filter((root) => root.scope !== "plugin").map((root) => root.rootPath),
  );
  const scanRootPaths = await dedupeScanRootsByRealpath([
    ...standaloneRoots,
    ...roots.filter((root) => root.scope === "plugin").map((root) => root.rootPath),
  ]);
  const rootByPath = new Map(roots.map((root) => [root.rootPath, root]));

  for (const rootPath of scanRootPaths) {
    const root = rootByPath.get(rootPath);
    if (!root) {
      continue;
    }
    if (!(await exists(root.rootPath))) {
      continue;
    }

    const skillPaths = await collectSkillMarkdownPaths(
      root.rootPath,
      diagnostics,
      root.scope === "plugin",
    );
    for (const skillPath of skillPaths) {
      if (
        await isUserAgentsSkillCoveredByZcode({
          skillPath,
          rootPath: root.rootPath,
          userZcodeSkillNameKeys,
        })
      ) {
        continue;
      }
      const canonicalSkillPath = await realpath(skillPath).catch(() => skillPath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);
      if (!(await exists(skillPath))) {
        continue;
      }
      let markdown: string;
      try {
        markdown = await readFile(skillPath, "utf-8");
      } catch (error) {
        diagnostics.push({
          code: "skill_read_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : `Failed to read skill: ${skillPath}`,
          path: skillPath,
        });
        continue;
      }
      const parsed = readFrontmatter(markdown);
      const skillFolderName = basename(dirname(skillPath));

      // name 校验只要求非空；大小写/下划线等是其它 skill 生态的合法显示名，不应产出噪音诊断。
      // 缺少 frontmatter 的手写 skill 不应显示不可操作的诊断；用目录名兜底，metadata 字段留空。
      const rawName = parsed.hasFrontmatter ? parsed.name.trim() : skillFolderName;
      const resolvedName = rawName || skillFolderName;
      if (!resolvedName) {
        diagnostics.push({
          code: "skill_missing_name",
          severity: "error",
          message: `Skill frontmatter must include a name: ${skillPath}`,
          path: skillPath,
        });
        continue;
      }

      const description = parsed.hasFrontmatter ? parsed.description.trim() : "";
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        diagnostics.push({
          code: "skill_description_too_long",
          severity: "error",
          message: `Skill description is too long (>${MAX_DESCRIPTION_LENGTH}): ${resolvedName}`,
          path: skillPath,
          skillName: resolvedName,
        });
        continue;
      }

      // frontmatter 扩展字段通常来自不同 skill 生态的元信息。
      // 这些字段不影响 ZCode 读取 name/description，继续报 warning 只会制造无操作价值的噪音。

      const body = parsed.body.trim();
      const metadata = await readSkillMetadata(skillPath);
      skills.push({
        id: buildSkillId({
          provider: params.provider,
          scope: root.scope,
          name: resolvedName,
          path: canonicalSkillPath,
        }),
        name: resolvedName,
        description,
        body,
        // SkillSummary.path 之前存的是技能目录，前端在生成 skill mention 链接时拿不到标准文件路径，
        // 最终只能得到 `[$skill](.../skill-dir)` 这种不完整引用。这里直接返回 `SKILL.md` 文件路径，
        // 让 UI、日志和后续技能跳转都能共享同一份标准定位信息。
        path: canonicalSkillPath,
        // 原始扫描路径（未 realpath）。软链技能删除时用它定位链接本体，避免误删目标目录。
        sourcePath: skillPath,
        scope: root.scope,
        enabled: true,
        ...(root.pluginName ? { pluginName: root.pluginName } : {}),
        ...(root.pluginId ? { pluginId: root.pluginId } : {}),
        ...(metadata ? { metadata } : {}),
      });
    }
  }

  skills.sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });

  return { skills, diagnostics };
}

async function collectSkillMarkdownPaths(
  rootPath: string,
  diagnostics: SkillDiagnostic[],
  stopAtSkill = false,
): Promise<string[]> {
  // 复用共享的有界遍历：支持分组目录，但排除 node_modules 等内容目录、限制深度、对软链按 realpath 去重，
  // 避免 Windows junction / 巨型依赖目录把单次扫描放大到数十秒。
  const discovered = new Set<string>();
  for await (const skillPath of walkSkillMarkdownPaths(rootPath, {
    stopAtSkill,
    onError: (path, error) => {
      diagnostics.push({
        code: "skill_scan_failed",
        severity: "warning",
        message: error instanceof Error ? error.message : `Failed to scan skill directory: ${path}`,
        path,
      });
    },
  })) {
    discovered.add(skillPath);
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

function resolveCapabilities(options?: SkillsServiceOptions): SkillsCapability {
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

function attachEnabledState(
  skills: SkillSummary[],
  enabledByPath: Record<string, boolean>,
): SkillSummary[] {
  return skills.map((skill) => ({
    ...skill,
    enabled: enabledByPath[normalizeSkillConfigPath(skill.path)] ?? true,
  }));
}

export function createSkillsService(options?: SkillsServiceOptions): ISkillsService {
  let writeQueue = Promise.resolve();

  return {
    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
    }): Promise<SkillsListResult> {
      const capability = resolveCapabilities(options);
      const provider = "glm";
      const { skills: discovered, diagnostics } = await discoverSkills({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        includeUserSkills: capability.userScopeAvailable,
        provider,
      });
      const enabledByPath = await readSkillEnabledMap();
      return {
        skills: attachEnabledState(discovered, enabledByPath),
        capability,
        diagnostics,
      };
    },

    async setEnabled(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      scope?: SkillScope;
      skillId: string;
      enabled: boolean;
    }): Promise<void> {
      const runUpdate = async () => {
        const provider = "glm";
        const capability = resolveCapabilities(options);
        const { skills } = await discoverSkills({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          includeUserSkills: capability.userScopeAvailable,
          provider,
        });
        const skill = skills.find((item) => item.id === params.skillId);
        if (!skill) {
          throw new Error(`Skill not found: ${params.skillId}`);
        }
        const enabledByPath = await readSkillEnabledMap();
        enabledByPath[normalizeSkillConfigPath(skill.path)] = params.enabled;
        await writeSkillEnabledMap(enabledByPath);
      };

      const queued = writeQueue.then(runUpdate, runUpdate);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async buildPromptContext(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      prompt: string;
    }): Promise<SkillsPromptContext> {
      const mentionedSkillNames = collectMentionedSkillNames(params.prompt);
      if (mentionedSkillNames.size === 0) {
        return { prompt: params.prompt, activatedSkillNames: [] };
      }

      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: params.provider,
      });
      const activatedSkills = skills.filter(
        (skill) => skill.enabled && mentionedSkillNames.has(skill.name),
      );
      if (activatedSkills.length === 0) {
        return { prompt: params.prompt, activatedSkillNames: [] };
      }

      const activatedSkillNames = activatedSkills.map((skill) => skill.name);
      // 技能目录是可见资源，但不能在每次 session 发送时全量注入。
      // 只有用户在 prompt 中显式提到且当前启用的技能才进入上下文，避免技能状态从 UI 列表泄漏到 agent 核心 session。
      await appendSkillsAuditLog({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        activatedSkillNames,
      });
      return {
        prompt: `${params.prompt}\n\n${buildActivatedSkillsPromptBlock(activatedSkills)}`,
        activatedSkillNames,
      };
    },

    async copyToCommon(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<{ newPath: string }> {
      // 从所有 provider 扫描结果中找目标 skill（list 已经扫过全量路径）
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      const sourceDir = dirname(skill.path);
      // 通用目录根据 skill 原 scope 确定 user 还是 workspace 级
      const commonRoot =
        skill.scope === "workspace"
          ? getWorkspaceZcodeSkillRoot(params.workspacePath)
          : getUserZcodeSkillRoot();
      const targetDir = join(commonRoot, basename(sourceDir));
      // 不覆盖已有目录
      if (await exists(targetDir)) {
        throw new Error(`通用目录已存在同名技能: ${basename(sourceDir)}`);
      }
      await mkdir(commonRoot, { recursive: true });
      await cp(sourceDir, targetDir, { recursive: true });
      return { newPath: join(targetDir, SKILL_FILE_NAME) };
    },

    async removeFromCommon(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<void> {
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      const normalizedPath = skill.path.replaceAll("\\", "/").toLowerCase();
      const userCommonRoot = getUserZcodeSkillRoot().replaceAll("\\", "/").toLowerCase();
      const workspaceCommonRoot = getWorkspaceZcodeSkillRoot(params.workspacePath)
        .replaceAll("\\", "/")
        .toLowerCase();
      const inUserCommon = normalizedPath.includes(`${userCommonRoot}/`);
      const inWorkspaceCommon = normalizedPath.includes(`${workspaceCommonRoot}/`);
      if (!inUserCommon && !inWorkspaceCommon) {
        throw new Error("该技能不在通用目录中");
      }
      await rm(dirname(skill.path), { recursive: true, force: true });
    },

    async deleteSkill(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<void> {
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      // plugin 作用域的技能由其所属插件管理，应通过卸载插件移除，这里拒绝单独删除。
      if (skill.scope === "plugin") {
        throw new Error("插件提供的技能不可单独删除，请卸载对应插件");
      }

      // 用发现阶段命中的原始路径（sourcePath，未 realpath）定位技能目录项。
      // 软链导入的技能 skill.path 是 realpath 后的目标文件，dirname 会指向目标目录；
      // sourcePath 才指向 `~/.zcode/skills/<name>` 下的目录项本身。
      const skillDir = dirname(skill.sourcePath ?? skill.path);
      const skillLeafName = basename(skillDir);
      // 只解析父目录，不解析叶子本身：
      // - 叶子若是软链（正常导入场景），保持不解析，删除时才只删链接、不动目标；
      // - 父目录 realpath 后，任何“软链/junction 祖先”都会被展开到真实位置，
      //   随后越界校验就能拦住“经由祖先软链删到受控根之外”的数据丢失路径。
      const canonicalParent = await realpath(dirname(skillDir)).catch(() => null);
      if (!canonicalParent) {
        throw new Error(`该技能不可删除: ${skill.path}`);
      }

      // 安全护栏：删除是 `rm -rf` 目录的破坏性操作，仅允许命中受控技能根。
      // 收集工作区各层级（沿 worktree 向上）的 .zcode/skills 与 .agents/skills，外加用户级两根。
      const allowedRootCandidates = await resolveAncestorWorkspaceRoots(params.workspacePath);
      allowedRootCandidates.push(getUserZcodeSkillRoot());
      allowedRootCandidates.push(getUserAgentsSkillRoot());

      // 用 realpath 后的父目录与 realpath 后的根比较：父目录必须落在（或等于）某个受控根内。
      // 两侧都 realpath，`/tmp`→`/private/tmp` 这类系统软链会在两侧抵消，不会误判越界。
      let contained = false;
      for (const root of allowedRootCandidates) {
        const canonicalRoot = await realpath(root).catch(() => root);
        const relativePath = relative(canonicalRoot, canonicalParent);
        // 父目录等于根（叶子直接位于根下）也是合法的常见场景，故允许 "".
        if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
          contained = true;
          break;
        }
      }

      if (!contained) {
        throw new Error(`该技能不可删除: ${skill.path}`);
      }
      // 删除 `<真实父目录>/<叶子名>`：父目录已是真实路径，不会经由祖先软链穿越；
      // 叶子仍是原目录项，是软链就只删链接、是普通目录就整目录删除。
      await rm(join(canonicalParent, skillLeafName), {
        recursive: true,
        force: true,
      });
    },
  };
}

// 仅供测试/调试，便于在 vitest 里直接 fixture 出诊断结果。
export const __INTERNAL__ = {
  discoverSkills,
  readFrontmatter,
  MAX_DESCRIPTION_LENGTH,
};
