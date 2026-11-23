/**
 * skill-live-catalog 对外契约：会话读 skill 目录快照、按历史只追加增量列表。
 * 目录来源是 adapters 的实时目录（SkillPort.currentCatalog）；这里不做任何 IO。
 */

/**
 * 持久化的 skill 列表增量：本条公告列出的 skill 显示名与整行指纹，两个数组等长。
 * 恢复只信结构化数据，不从正文推断已公告的行。宽松字段，旧版本读到时忽略。
 */
export interface SkillsListingDelta {
  names: string[];
  fingerprints: string[];
}
