import type { Dirent } from "node:fs";
// ============================================================
// 技能根扫描规则（共享实现）
// ============================================================

// manifest 的 skills 项既可指向单个技能目录，也可指向一层技能集合。
// 插件根目录含 SKILL.md 时只加载根技能，否则扫描一层子目录；
// 用户级、项目级根仍同时识别根技能与一层子技能。
// 插件发现与技能 adapter 共用同一异步实现，保持扫描深度与符号链接规则一致。
//
// 错误契约：只吞「常态缺失」——路径不存在（ENOENT）或不是目录时返回空数组；其余错误
// （如 EACCES 权限、EMFILE）必须向上抛，由调用方决定发 skill_scan_failed 诊断还是
// 优雅降级。外层 catch 不能吞掉一切错误：权限错误会退化为静默空、skill_scan_failed
// 诊断成为死代码，重新引入了静默失败路径。
//
// 信任边界：plugin-scope 内容不可信，符号链接（含 Windows
// junction——Dirent.isSymbolicLink/lstat 对两者均返回 true）可指向插件根外的任意
// 目录或文件（目录级 skills/evil-link -> ../../outside、文件级 SKILL.md -> ~/.aws/
// credentials）。曾尝试 realpath containment，但边界作为可选参数沿数据流散布，每个
// 文件接触点都要记得校验（文件级链接、跨盘符 relative 谓词、manifest 失败回退均成
// 缺口）。收敛为单一规则：插件扫描一律不跟随符号链接——根自身、子目录候选、
// SKILL.md 文件三个粒度全部拒绝链接（拒绝即无逃逸，无需判定链接指向何处）。
// 用户级技能根（~/.zcode/skills 的 symlink 导入是受支持功能）保持默认跟随。

import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_FILE_NAME, shouldWalkSkillDirectoryEntry } from "@zcode/shared";

export interface ScanSkillFilesOptions {
  /**
   * 是否跟随符号链接（目录级与文件级），默认 true（用户级技能根的 symlink 导入
   * 是受支持功能）。plugin-scope 扫描必须传 false：链接可指向插件根外，拒绝
   * 链接即拒绝逃逸，无需 realpath 判定指向。
   */
  followSymbolicLinks?: boolean;
  /** 插件入口自身是技能时停止，不探测其附属目录。 */
  stopAtSkill?: boolean;
  readDirectory?: (path: string) => Promise<Dirent[]>;
  observe?: (path: string) => Promise<"file" | "directory" | "other" | "missing">;
}

/**
 * 根目录下所有真实存在的 SKILL.md 绝对路径（含根自身）。
 * 根目录不存在或不是目录返回空数组；扫描过程中的其他错误（EACCES 等）向上抛。
 */
export async function scanSkillFilesUnderRoot(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): Promise<string[]> {
  const followSymlinks = options.followSymbolicLinks ?? true;
  // 根自身是链接（含 junction）时，插件扫描直接判空。
  if (!followSymlinks && (await isSymbolicLink(rootPath))) return [];

  if ((await pathKind(rootPath, options.observe)) !== "directory") return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  // 根自身无 SKILL.md 是常态，继续扫一层子目录。
  if (await isLoadableSkillFile(own, followSymlinks, options.observe)) {
    files.push(own);
    // 单技能的 scripts、agents 等附属目录不是隐式入口，避免额外发现和无效 IO。
    if (options.stopAtSkill) return files;
  }

  const entries = await (options.readDirectory?.(rootPath) ??
    readdir(rootPath, { withFileTypes: true }));
  for (const entry of entries) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    // 子目录命中的路径必须校验文件真实存在：分类目录（如 skills/engineering/）
    // 不是技能目录，拼出来的路径不存在；parseSkill 本会静默跳过，但计数与
    // 组件枚举都消费该结果，不校验会把「不存在的技能」算进来。
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (await isLoadableSkillFile(candidate, followSymlinks, options.observe))
      files.push(candidate);
  }
  return files;
}

/**
 * SKILL.md 候选的可加载判定：真实文件才收录。不跟随链接时符号链接文件
 * （含 junction）一律拒绝——这是文件级逃逸（SKILL.md -> 外部任意文件）的防线。
 */
async function isLoadableSkillFile(
  path: string,
  followSymlinks: boolean,
  observe?: ScanSkillFilesOptions["observe"],
): Promise<boolean> {
  if (!followSymlinks && (await isSymbolicLink(path))) return false;
  return (await pathKind(path, observe)) === "file";
}

async function pathKind(path: string, observe: ScanSkillFilesOptions["observe"]) {
  // material reader 已查到文件类型，复用该事实，避免每个技能再 stat 一遍。
  if (observe) return observe(path);
  const info = await stat(path).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  return info?.isFile() ? "file" : info?.isDirectory() ? "directory" : info ? "other" : "missing";
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** ENOENT（路径不存在）是扫描常态，吞掉；其余错误（EACCES 等）向上抛。 */
function throwIfUnexpectedScanError(error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return;
  }
  throw error;
}
