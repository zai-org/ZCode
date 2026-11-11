/** 控制端显示偏好不写远端 position；暂时不可见的入口保留原位置。 */
export function reconcileProjectOrder(
  saved: readonly string[],
  current: readonly string[],
  upgradeKeys?: ReadonlyMap<string, string>,
): string[] {
  const retained = upgradeKeys?.size
    ? saved.map((key) => {
        try {
          // 首次升级入口解析后 projectId/Host 会变化；按入口 ID 原位换键，不能当新项目追加到末尾。
          const identity: unknown = JSON.parse(key);
          return Array.isArray(identity) ? (upgradeKeys.get(identity[1]) ?? key) : key;
        } catch {
          return key;
        }
      })
    : saved;
  // 手机等接收端没有创建页面的 prepend 回调；旧逻辑把新项目追加到末尾。
  // 仅将未记录的项目按目录顺序前插，已记录项目（包括暂时离线项）保留手动位置。
  const existing = new Set(retained);
  return [...new Set([...current.filter((key) => !existing.has(key)), ...retained])];
}
export function moveProjectOrder(
  saved: readonly string[],
  section: readonly string[],
  active: string,
  over: string,
): string[] {
  const from = section.indexOf(active),
    to = section.indexOf(over);
  if (from < 0 || to < 0 || from === to) return [...saved];
  const moved = [...section];
  moved.splice(to, 0, moved.splice(from, 1)[0]!);
  const members = new Set(section);
  let index = 0;
  return reconcileProjectOrder(saved, section).map((key) =>
    members.has(key) ? moved[index++]! : key,
  );
}
