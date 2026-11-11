// 编辑器身份（docs/ui/composer-edit-mode.md「锁归属」）：editorId 存在 sessionStorage，刷新后沿用；
// 浏览器「复制标签页」会连同 sessionStorage 复制，两个在线页面可能共用同一 id，复制出的页面会把
// 原页面正在编辑的锁当成自己的遗留锁释放掉。每个页面在生命周期内持有同名 Web Lock：申请不到即说明
// 另一在线页面正在使用，换新 id 再申请。锁随页面卸载自动释放，不需要超时。
import { useSyncExternalStore } from "react";
import { logger } from "@/logger.js";
import { getV4EditorId, regenerateV4EditorId } from "@/v4/commandFactory.js";

interface EditorIdentity {
  editorId: string;
  /** 已确认没有其他在线页面使用该 id；确认前不发锁命令、不自动释放遗留锁。 */
  confirmed: boolean;
}

const listeners = new Set<() => void>();
let identity: EditorIdentity | null = null;
let ready: Promise<string> | null = null;

function publish(next: EditorIdentity) {
  identity = next;
  for (const listener of listeners) listener();
}

/** 持有以 editorId 命名的 Web Lock 直到页面卸载；已被占用返回 false。 */
function holdEditorLock(locks: LockManager, editorId: string): Promise<boolean> {
  return new Promise((acquired) => {
    void locks
      .request(`zcode-v4-editor:${editorId}`, { ifAvailable: true }, (lock) => {
        acquired(lock !== null);
        // 返回不结束的 Promise：锁一直保持到页面卸载。
        return lock ? new Promise<never>(() => {}) : undefined;
      })
      .catch((error: unknown) => {
        logger.warn("[v4-composer-edit] 编辑器身份锁申请失败，沿用当前 editorId", error);
        acquired(true);
      });
  });
}

async function confirmEditorIdentity(): Promise<string> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  let editorId = getV4EditorId();
  if (locks) {
    while (!(await holdEditorLock(locks, editorId))) {
      const previous = editorId;
      editorId = regenerateV4EditorId();
      logger.info("[v4-composer-edit] editorId 已被另一在线页面使用，换新 id", {
        previous,
        editorId,
      });
    }
  }
  publish({ editorId, confirmed: true });
  return editorId;
}

/** 本页面确认后的 editorId；多次调用共享同一次确认。 */
export function ensureEditorIdentity(): Promise<string> {
  ready ??= confirmEditorIdentity();
  return ready;
}

function getIdentity(): EditorIdentity {
  identity ??= { editorId: getV4EditorId(), confirmed: false };
  return identity;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void ensureEditorIdentity();
  return () => listeners.delete(listener);
}

export function useEditorIdentity(): EditorIdentity {
  return useSyncExternalStore(subscribe, getIdentity, getIdentity);
}
