// 服务端规则驱动的草稿模型迁移：纯判定与客户端标记，规格见 docs/chat/draft-model-migration.md。
// 判定只读目标 Host 的 ModelSelectionView，标记存在本设备 localStorage，不进 Session 或 Host 状态。
import { completeNewModelSelection } from "@zcode/provider";
import {
  OFFICIAL_PROVIDER_TEMPLATE_IDS,
  type DraftModelMigrationNotice,
  type DraftModelMigrationRule,
} from "@zcode/shared";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ModelSelectionView } from "@zcode/services";
import { logger } from "@/logger.js";
import { composerScopeKey, type ComposerScope } from "@/v4/composer/composerDraftStore.js";

/** 一次打开 Root 草稿时选择的唯一来源；只有这两种来源参与迁移。 */
export type DraftModelMigrationSource = "rootDraft" | "recent";

export type DraftModelMigrationDecision =
  /** 条件暂不满足，不写标记，下次打开再判定。 */
  | { readonly kind: "skip"; readonly reason: string }
  /** 本规则版本对该来源已有结论，写标记但不切换。 */
  | { readonly kind: "settle"; readonly reason: string }
  | {
      readonly kind: "migrate";
      readonly from: ModelSelection;
      readonly selection: ModelSelection;
    };

const MARKER_KEY_PREFIX = "zcode-draft-model-migration:v1:";
const NOTICE_KEY = "zcode-draft-model-migration-notice:v1";

export function decideDraftModelMigration(input: {
  readonly rule: DraftModelMigrationRule;
  readonly marker: number | undefined;
  /** 本次打开时来源中的原选择，即 View 的解析输入。 */
  readonly base: ModelSelection;
  /** 已对 base 解析完成的 ready View。 */
  readonly view: ModelSelectionView;
}): DraftModelMigrationDecision {
  const { rule, base, view } = input;
  if ((input.marker ?? 0) >= rule.revision) return { kind: "skip", reason: "already-decided" };
  // 失效选择保持既有“留空等用户重选”行为，不替用户换成其他模型。
  const effective = view.effectiveSelection;
  if (!effective || view.selectionIssue) return { kind: "skip", reason: "selection-unavailable" };
  // 账号套餐会按当前连接重映射，必须按有效 Provider 判定官方来源和目标模型。
  const provider = view.providers.find(
    (candidate) => candidate.providerId === effective.providerId,
  );
  if (!provider) return { kind: "skip", reason: "provider-unavailable" };
  const official =
    provider.config.access?.type === "zhipu-account" ||
    (typeof provider.templateId === "string" &&
      OFFICIAL_PROVIDER_TEMPLATE_IDS.includes(provider.templateId));
  if (!official) return { kind: "settle", reason: "unofficial-provider" };
  if (effective.modelId === rule.targetModelId) return { kind: "settle", reason: "already-target" };
  if (rule.sourceModelIds && !rule.sourceModelIds.includes(effective.modelId))
    return { kind: "settle", reason: "not-source-model" };
  const target = provider.models.find((model) => model.modelId === rule.targetModelId);
  if (!target) return { kind: "skip", reason: "target-unavailable" };
  const reasoningLevel = effective.options?.reasoningLevel;
  const completed =
    reasoningLevel !== undefined &&
    target.config.optionSpecs.reasoningLevel.values.includes(reasoningLevel)
      ? { options: { reasoningLevel } }
      : completeNewModelSelection(view, {
          providerId: provider.providerId,
          modelId: rule.targetModelId,
        });
  if (!completed?.options) return { kind: "skip", reason: "target-unavailable" };
  return {
    kind: "migrate",
    from: effective,
    // 保留原 providerId：账号套餐的连接重映射继续由 View 负责，不把当前连接写死进意图。
    selection: {
      providerId: base.providerId,
      modelId: rule.targetModelId,
      options: completed.options,
    },
  };
}

export function readDraftModelMigrationMarker(
  scope: ComposerScope,
  source: DraftModelMigrationSource,
): number | undefined {
  const value = readStorageJson(markerKey(scope));
  const revision = isRecord(value) ? value[source] : undefined;
  return typeof revision === "number" ? revision : undefined;
}

export function writeDraftModelMigrationMarker(
  scope: ComposerScope,
  source: DraftModelMigrationSource,
  revision: number,
): void {
  const key = markerKey(scope);
  const value = readStorageJson(key);
  const current = isRecord(value) ? value : {};
  const existing = current[source];
  // 只前进不后退：服务端回退到低 revision 不能让已判定的作用域重新迁移。
  if (typeof existing === "number" && existing >= revision) return;
  writeStorageJson(key, { ...current, [source]: revision });
}

/** 气泡每台设备每个规则版本只显示一次。 */
export function shouldShowDraftModelMigrationNotice(revision: number): boolean {
  const value = readStorageJson(NOTICE_KEY);
  const shown = isRecord(value) ? value.revision : undefined;
  return typeof shown !== "number" || shown < revision;
}

/**
 * 按本设备界面语言取气泡文案：精确语言 → 同语种 → 英文 → 无（不弹气泡）。
 * 同一级多条命中时先取与语种完全相同的键（如 zh），否则按服务端下发顺序取第一条。
 */
export function resolveDraftModelMigrationNoticeText(
  notice: DraftModelMigrationNotice,
  locale: string,
): string | null {
  const entries = Object.entries(notice).map(([key, text]) => [key.toLowerCase(), text] as const);
  const pick = (exact: string, language: string) =>
    entries.find(([key]) => key === exact)?.[1] ??
    entries.find(([key]) => key === language)?.[1] ??
    entries.find(([key]) => key.startsWith(`${language}-`))?.[1];
  const normalized = locale.toLowerCase();
  return pick(normalized, normalized.split("-")[0]!) ?? pick("en-us", "en") ?? null;
}

export function markDraftModelMigrationNoticeShown(revision: number): void {
  if (shouldShowDraftModelMigrationNotice(revision)) writeStorageJson(NOTICE_KEY, { revision });
}

function markerKey(scope: ComposerScope): string {
  return `${MARKER_KEY_PREFIX}${composerScopeKey(scope)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStorageJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    // 损坏或不可读的标记按未判定处理；最坏结果是同一规则再判定一次。
    return null;
  }
}

function writeStorageJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    logger.lifecycle.warn("[draft-model-migration] 迁移标记写入失败", { key, error });
  }
}
