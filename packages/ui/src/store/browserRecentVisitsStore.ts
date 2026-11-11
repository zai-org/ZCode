import { useMemo } from "react";
import { create } from "zustand";
import { writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

export interface BrowserVisitScope {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
}

export interface BrowserVisitRecord {
  url: string;
  title: string;
  faviconUrl: string | null;
  lastVisitedAt: number;
}

interface BrowserRecentVisitsState {
  scopes: Record<string, BrowserVisitRecord[]>;
}

const MAX_RECENT_VISITS = 20;
const MAX_RECENT_VISIT_SCOPES = 50;
const MAX_PERSISTED_FAVICON_URL_LENGTH = 2 * 1024;
const STORAGE_KEY_PREFIX = "zcode-browser-recent-visits:";

function normalizePersistedVisit(record: BrowserVisitRecord): BrowserVisitRecord {
  const faviconUrl = record.faviconUrl;
  const safeFaviconUrl =
    faviconUrl && faviconUrl.length <= MAX_PERSISTED_FAVICON_URL_LENGTH && isHttpUrl(faviconUrl)
      ? faviconUrl
      : null;
  return safeFaviconUrl === faviconUrl ? record : { ...record, faviconUrl: safeFaviconUrl };
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isBrowserVisitRecord(value: unknown): value is BrowserVisitRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<BrowserVisitRecord>;
  return (
    typeof record.url === "string" &&
    isTrackableBrowserVisitUrl(record.url) &&
    typeof record.title === "string" &&
    (typeof record.faviconUrl === "string" || record.faviconUrl === null) &&
    typeof record.lastVisitedAt === "number" &&
    Number.isFinite(record.lastVisitedAt)
  );
}

function isValidScopeKey(scopeKey: string): boolean {
  try {
    const scope: unknown = JSON.parse(scopeKey);
    return (
      Array.isArray(scope) &&
      scope.length === 3 &&
      scope.every((part) => typeof part === "string") &&
      Boolean(scope[0]?.trim()) &&
      Boolean(scope[2]?.trim()) &&
      scope[2] !== "unscoped"
    );
  } catch {
    return false;
  }
}

function readScopeIdentity(scopeKey: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(scopeKey);
    return Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((part) => typeof part === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function loadRecentVisits(): Record<string, BrowserVisitRecord[]> {
  if (typeof window === "undefined") return {};
  try {
    const storage = window.localStorage;
    const loaded: Array<[string, BrowserVisitRecord[]]> = [];
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => key?.startsWith(STORAGE_KEY_PREFIX) === true,
    );
    for (const key of keys) {
      const scopeKey = key.slice(STORAGE_KEY_PREFIX.length);
      if (!isValidScopeKey(scopeKey)) continue;
      try {
        const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
        if (!Array.isArray(parsed)) continue;
        const visits = parsed
          .filter(isBrowserVisitRecord)
          .slice(0, MAX_RECENT_VISITS)
          .map(normalizePersistedVisit);
        if (visits.length > 0) {
          loaded.push([scopeKey, visits]);
          if (JSON.stringify(visits) !== JSON.stringify(parsed.slice(0, MAX_RECENT_VISITS))) {
            persistScopeVisits(scopeKey, visits);
          }
        } else {
          removePersistedScope(scopeKey);
        }
      } catch {
        // 损坏的单个 scope 不影响其他会话的访问记录。
      }
    }

    loaded.sort((left, right) => newestVisitAt(right[1]) - newestVisitAt(left[1]));
    for (const [scopeKey] of loaded.slice(MAX_RECENT_VISIT_SCOPES)) removePersistedScope(scopeKey);
    return Object.fromEntries(loaded.slice(0, MAX_RECENT_VISIT_SCOPES));
  } catch {
    return {};
  }
}

function newestVisitAt(visits: BrowserVisitRecord[]): number {
  return visits.reduce((latest, visit) => Math.max(latest, visit.lastVisitedAt), 0);
}

function persistScopeVisits(scopeKey: string, visits: BrowserVisitRecord[]): void {
  writeSafeLocalStorage(
    `${STORAGE_KEY_PREFIX}${scopeKey}`,
    JSON.stringify(visits.slice(0, MAX_RECENT_VISITS).map(normalizePersistedVisit)),
  );
}

function removePersistedScope(scopeKey: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${STORAGE_KEY_PREFIX}${scopeKey}`);
  } catch {
    // 清理历史不能阻断任务删除。
  }
}

export function clearBrowserRecentVisitsForTask(workspaceKey: string, sessionId: string): void {
  const normalizedWorkspaceKey = workspaceKey.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedWorkspaceKey || !normalizedSessionId || normalizedSessionId === "unscoped") return;

  const scopes = { ...useBrowserRecentVisitsStore.getState().scopes };
  const removedScopeKeys = new Set<string>();
  for (const scopeKey of Object.keys(scopes)) {
    const scope = readScopeIdentity(scopeKey);
    if (scope?.[0] !== normalizedWorkspaceKey || scope[2] !== normalizedSessionId) continue;
    delete scopes[scopeKey];
    removedScopeKeys.add(scopeKey);
  }
  if (typeof window !== "undefined") {
    try {
      const storage = window.localStorage;
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(STORAGE_KEY_PREFIX)) continue;
        const scopeKey = key.slice(STORAGE_KEY_PREFIX.length);
        const scope = readScopeIdentity(scopeKey);
        if (scope?.[0] === normalizedWorkspaceKey && scope[2] === normalizedSessionId) {
          removedScopeKeys.add(scopeKey);
        }
      }
    } catch {
      // localStorage 不可用时仍清理内存桶。
    }
  }
  if (removedScopeKeys.size === 0) return;
  useBrowserRecentVisitsStore.setState({ scopes });
  removedScopeKeys.forEach(removePersistedScope);
}

function removePersistedRecentVisits(): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => Boolean(key?.startsWith(STORAGE_KEY_PREFIX)),
    );
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // 清理历史不能阻断浏览器主流程。
  }
}

function handleRecentVisitsStorage(event: StorageEvent): void {
  if (event.storageArea !== window.localStorage) return;
  if (event.key === null) {
    useBrowserRecentVisitsStore.setState({ scopes: {} });
    return;
  }
  if (!event.key.startsWith(STORAGE_KEY_PREFIX)) return;
  const scopeKey = event.key.slice(STORAGE_KEY_PREFIX.length);
  if (!isValidScopeKey(scopeKey)) return;
  const scopes = { ...useBrowserRecentVisitsStore.getState().scopes };
  if (event.newValue === null) {
    delete scopes[scopeKey];
  } else {
    try {
      const parsed: unknown = JSON.parse(event.newValue);
      const visits = Array.isArray(parsed)
        ? parsed
            .filter(isBrowserVisitRecord)
            .slice(0, MAX_RECENT_VISITS)
            .map(normalizePersistedVisit)
        : [];
      if (visits.length > 0) scopes[scopeKey] = visits;
      else delete scopes[scopeKey];
    } catch {
      delete scopes[scopeKey];
    }
  }
  useBrowserRecentVisitsStore.setState({ scopes });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", handleRecentVisitsStorage);
}

export const useBrowserRecentVisitsStore = create<BrowserRecentVisitsState>()(() => ({
  scopes: loadRecentVisits(),
}));

function updateScopes(
  update: (scopes: Record<string, BrowserVisitRecord[]>) => Record<string, BrowserVisitRecord[]>,
): void {
  const previous = useBrowserRecentVisitsStore.getState().scopes;
  const next = update(previous);
  const ranked = Object.entries(next).sort(
    (left, right) => newestVisitAt(right[1]) - newestVisitAt(left[1]),
  );
  const retained = ranked.slice(0, MAX_RECENT_VISIT_SCOPES);
  const scopes = Object.fromEntries(retained);
  const retainedKeys = new Set(retained.map(([scopeKey]) => scopeKey));
  for (const scopeKey of Object.keys(previous)) {
    if (!retainedKeys.has(scopeKey)) removePersistedScope(scopeKey);
  }
  useBrowserRecentVisitsStore.setState({ scopes });
  for (const [scopeKey, visits] of retained) {
    const previousVisits = previous[scopeKey] ?? [];
    if (
      visits !== previous[scopeKey] &&
      JSON.stringify(visits.map(normalizePersistedVisit)) !==
        JSON.stringify(previousVisits.map(normalizePersistedVisit))
    ) {
      persistScopeVisits(scopeKey, visits);
    }
  }
}

export function clearBrowserRecentVisits(): void {
  useBrowserRecentVisitsStore.setState({ scopes: {} });
  removePersistedRecentVisits();
}

export function getBrowserVisitScopeKey(scope: BrowserVisitScope): string | null {
  const workspaceKey = scope.workspaceKey.trim();
  const sessionId = scope.sessionId.trim();
  // unscoped 仅是 Browser IPC 的草稿编码，不能把无会话页面并入一个共享历史桶。
  if (!workspaceKey || !sessionId || sessionId === "unscoped") return null;
  return JSON.stringify([workspaceKey, scope.remoteSessionId?.trim() ?? "", sessionId]);
}

export function readBrowserRecentVisits(scopeKey: string | null): BrowserVisitRecord[] {
  if (!scopeKey) return [];
  return useBrowserRecentVisitsStore.getState().scopes[scopeKey] ?? [];
}

export function removeBrowserRecentVisit(scopeKey: string | null, url: string): void {
  if (!scopeKey) return;
  const current = useBrowserRecentVisitsStore.getState().scopes[scopeKey];
  if (!current?.some((visit) => visit.url === url)) return;
  updateScopes((scopes) => {
    const visits = current.filter((visit) => visit.url !== url);
    const next = { ...scopes };
    if (visits.length > 0) next[scopeKey] = visits;
    else delete next[scopeKey];
    return next;
  });
}

export function recordBrowserVisit(scopeKey: string | null, visit: BrowserVisitRecord): void {
  if (!scopeKey || !isTrackableBrowserVisitUrl(visit.url)) return;
  updateScopes((scopes) => {
    const current = scopes[scopeKey] ?? [];
    const existing = current.find((item) => item.url === visit.url);
    const next = [
      {
        ...visit,
        title: visit.title || existing?.title || "",
        faviconUrl: visit.faviconUrl ?? existing?.faviconUrl ?? null,
      },
      ...current.filter((item) => item.url !== visit.url),
    ].slice(0, MAX_RECENT_VISITS);
    return { ...scopes, [scopeKey]: next };
  });
}

export function updateBrowserVisitMetadata(
  scopeKey: string | null,
  url: string,
  metadata: Pick<BrowserVisitRecord, "title" | "faviconUrl">,
): void {
  if (!scopeKey) return;
  const scopes = useBrowserRecentVisitsStore.getState().scopes;
  const current = scopes[scopeKey];
  const existing = current?.find((item) => item.url === url);
  if (!current || !existing) return;
  const title = metadata.title || existing.title;
  const faviconUrl = metadata.faviconUrl ?? existing.faviconUrl;
  // 内存展示保留页面原值；持久化归一化只在 updateScopes 写盘前比较，避免 data/file 图标更新被跳过。
  if (title === existing.title && faviconUrl === existing.faviconUrl) return;
  updateScopes((state) => ({
    ...state,
    [scopeKey]: current.map((item) => (item.url === url ? { ...item, title, faviconUrl } : item)),
  }));
}

export function isTrackableBrowserVisitUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

export function useBrowserRecentVisits(scopeKey: string | null): BrowserVisitRecord[] {
  const selector = useMemo(
    () => (state: BrowserRecentVisitsState) =>
      scopeKey ? (state.scopes[scopeKey] ?? EMPTY_VISITS) : EMPTY_VISITS,
    [scopeKey],
  );
  return useBrowserRecentVisitsStore(selector);
}

const EMPTY_VISITS: BrowserVisitRecord[] = [];
