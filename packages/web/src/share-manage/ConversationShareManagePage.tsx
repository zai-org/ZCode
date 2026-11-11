import { useCallback, useEffect, useRef, useState } from "react";
import {
  conversationShareTtlChoices,
  localizeConversationShareUrl,
  type ConversationShareAccessMode,
  type ConversationShareManagedItem,
  type ConversationShareManagedUpdateRequest,
} from "@zcode/shared";
import { applyTheme, type Theme } from "@zcode/ui/useTheme";
import { Button } from "@zcode/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@zcode/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zcode/ui/dropdown-menu";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  RotateCcwIcon,
  Trash2Icon,
  CircleXIcon,
} from "lucide-react";
import type { WebOAuthProviderId } from "#src/auth/contract.js";
import {
  ConversationShareLandingStatus,
  ShareBrandMark,
  ShareThemeToggle,
  type ConversationShareLandingLocale,
  type ConversationShareLandingState,
} from "../share/ConversationShareLandingPage.js";
import type { ConversationSharePreviewClientError } from "../share/conversationSharePreviewClient.js";
import type { ConversationShareManageApi } from "./contract.js";
import { errorKindOf, logManageFailure } from "./manageFailure.js";

type Visibility = "private" | "link";
type ImportPermission = "readonly" | "importable";
type ConfirmAction =
  | { kind: "make_public"; item: ConversationShareManagedItem }
  | { kind: "revoke"; item: ConversationShareManagedItem }
  | { kind: "delete"; item: ConversationShareManagedItem };

interface ManageCopy {
  brand: string;
  pageTitle: string;
  loginTitle: string;
  loginDescription: string;
  emptyTitle: string;
  emptyDescription: string;
  statusActive: string;
  statusRevoked: string;
  createdAt: string;
  expiresAt: string;
  visibilityLabel: string;
  visibilityPrivate: string;
  visibilityLink: string;
  importLabel: string;
  importReadonly: string;
  importImportable: string;
  expiryLabel: string;
  remainingDay: string;
  remainingDays: string;
  remainingHour: string;
  remainingHours: string;
  remainingLessThanHour: string;
  more: string;
  hour: string;
  hours: string;
  day: string;
  days: string;
  copyLink: string;
  copied: string;
  open: string;
  revoke: string;
  restore: string;
  remove: string;
  loadMore: string;
  loadingMore: string;
  cancel: string;
  makePublicTitle: string;
  makePublicDescription: string;
  makePublicConfirm: string;
  revokeTitle: string;
  revokeDescription: string;
  removeTitle: string;
  removeDescription: string;
  rowFailed: string;
  rowRateLimited: string;
  rowRemovedNotice: string;
  loadMoreFailed: string;
  switchToDarkTheme: string;
  switchToLightTheme: string;
}

const COPY: Record<ConversationShareLandingLocale, ManageCopy> = {
  "zh-CN": {
    brand: "ZCode",
    pageTitle: "我的分享",
    loginTitle: "登录后管理分享",
    loginDescription: "请使用创建分享时的账号登录，查看和管理你的分享。",
    emptyTitle: "还没有生效中的分享",
    emptyDescription: "在 ZCode 中分享会话后会显示在这里。已过期的分享不会显示。",
    statusActive: "生效中",
    statusRevoked: "已撤销",
    createdAt: "创建于 {time}",
    expiresAt: "到期 {time}",
    visibilityLabel: "可见范围",
    visibilityPrivate: "仅自己",
    visibilityLink: "凭链接查看",
    importLabel: "导入权限",
    importReadonly: "仅查看",
    importImportable: "可导入并继续",
    expiryLabel: "有效期（从现在起）",
    remainingDay: "剩余 1 天",
    remainingDays: "剩余 {count} 天",
    remainingHour: "剩余 1 小时",
    remainingHours: "剩余 {count} 小时",
    remainingLessThanHour: "不足 1 小时",
    more: "更多操作",
    hour: "1 小时",
    hours: "{count} 小时",
    day: "1 天",
    days: "{count} 天",
    copyLink: "复制链接",
    copied: "已复制",
    open: "打开",
    revoke: "撤销",
    restore: "恢复",
    remove: "删除",
    loadMore: "加载更多",
    loadingMore: "正在加载…",
    cancel: "取消",
    makePublicTitle: "改为凭链接可见？",
    makePublicDescription: "拥有链接的任何人都可以查看这个分享，包括未登录的访客。",
    makePublicConfirm: "确认公开",
    revokeTitle: "撤销这个分享？",
    revokeDescription:
      "链接会立即失效，之后可以恢复。已打开页面中的下载链接会在短时间内自然失效，已导入的副本不受影响。",
    removeTitle: "删除这个分享？",
    removeDescription: "删除后链接永久失效，分享内容会被清除，无法恢复。",
    rowFailed: "操作失败，请重试。",
    rowRateLimited: "操作过于频繁，请稍后重试。",
    rowRemovedNotice: "有分享已失效，已从列表中移除。",
    loadMoreFailed: "加载失败，请重试。",
    switchToDarkTheme: "切换到深色主题",
    switchToLightTheme: "切换到浅色主题",
  },
  "en-US": {
    brand: "ZCode",
    pageTitle: "My shares",
    loginTitle: "Sign in to manage your shares",
    loginDescription: "Sign in with the account you used to create the shares.",
    emptyTitle: "No active shares",
    emptyDescription:
      "Conversations you share from ZCode appear here. Expired shares are not shown.",
    statusActive: "Active",
    statusRevoked: "Revoked",
    createdAt: "Created {time}",
    expiresAt: "Expires {time}",
    visibilityLabel: "Visibility",
    visibilityPrivate: "Only me",
    visibilityLink: "Anyone with the link",
    importLabel: "Import",
    importReadonly: "View only",
    importImportable: "Import & continue",
    expiryLabel: "Expires after (from now)",
    remainingDay: "1 day left",
    remainingDays: "{count} days left",
    remainingHour: "1 hour left",
    remainingHours: "{count} hours left",
    remainingLessThanHour: "Less than 1 hour left",
    more: "More actions",
    hour: "1 hour",
    hours: "{count} hours",
    day: "1 day",
    days: "{count} days",
    copyLink: "Copy link",
    copied: "Copied",
    open: "Open",
    revoke: "Revoke",
    restore: "Restore",
    remove: "Delete",
    loadMore: "Load more",
    loadingMore: "Loading…",
    cancel: "Cancel",
    makePublicTitle: "Make visible to anyone with the link?",
    makePublicDescription:
      "Anyone who has the link can view this share, including visitors who are not signed in.",
    makePublicConfirm: "Make visible",
    revokeTitle: "Revoke this share?",
    revokeDescription:
      "The link stops working now. You can restore it later. Download links in pages that are already open expire shortly; imported copies are not affected.",
    removeTitle: "Delete this share?",
    removeDescription:
      "The link stops working permanently and the shared content is removed. You cannot undo this.",
    rowFailed: "The action failed. Try again.",
    rowRateLimited: "Too many requests. Try again later.",
    rowRemovedNotice: "A share is no longer available and was removed from the list.",
    loadMoreFailed: "Unable to load more. Try again.",
    switchToDarkTheme: "Switch to dark theme",
    switchToLightTheme: "Switch to light theme",
  },
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COPIED_FEEDBACK_MS = 1500;

function formatTtl(copy: ManageCopy, ttlMs: number): string {
  if (ttlMs % DAY_MS === 0) {
    const count = ttlMs / DAY_MS;
    return (count === 1 ? copy.day : copy.days).replace("{count}", String(count));
  }
  const count = Math.max(1, Math.round(ttlMs / HOUR_MS));
  return (count === 1 ? copy.hour : copy.hours).replace("{count}", String(count));
}

// 只用于展示：过期判定以服务端为准，这里不据此隐藏或改状态。
function formatRemaining(copy: ManageCopy, expiresAt: number): string {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs >= DAY_MS) {
    const count = Math.floor(remainingMs / DAY_MS);
    return count === 1 ? copy.remainingDay : copy.remainingDays.replace("{count}", String(count));
  }
  if (remainingMs >= HOUR_MS) {
    const count = Math.floor(remainingMs / HOUR_MS);
    return count === 1 ? copy.remainingHour : copy.remainingHours.replace("{count}", String(count));
  }
  return copy.remainingLessThanHour;
}

function formatTime(timestamp: number, locale: ConversationShareLandingLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp),
  );
}

function visibilityOf(mode: ConversationShareAccessMode): Visibility {
  return mode === "private" ? "private" : "link";
}

function importPermissionOf(mode: ConversationShareAccessMode): ImportPermission {
  return mode === "public_importable" ? "importable" : "readonly";
}

const MENU_GROUP_LABEL_CLASS = "py-1 text-ui-sm font-normal";

function ManagedShareRow({
  item,
  copy,
  locale,
  pending,
  error,
  onUpdate,
  onConfirm,
  onRestore,
  ttlChoices,
}: {
  item: ConversationShareManagedItem;
  copy: ManageCopy;
  locale: ConversationShareLandingLocale;
  pending: boolean;
  error?: string;
  onUpdate: (change: ConversationShareManagedUpdateRequest) => void;
  onConfirm: (action: ConfirmAction) => void;
  onRestore: () => void;
  /** 服务端范围内的有效期选项；为空时不显示有效期分组。 */
  ttlChoices: readonly number[];
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const shareUrl = localizeConversationShareUrl(item.share_url, locale);
  const visibility = visibilityOf(item.access_mode);
  const importPermission = importPermissionOf(item.access_mode);
  const revoked = item.status === "revoked";
  const expiresAtText = copy.expiresAt.replace("{time}", formatTime(item.expires_at, locale));
  const copyLabel = copied ? copy.copied : copy.copyLink;

  const handleCopy = () => {
    void navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  };

  return (
    <li
      data-share-manage-item={item.share_id}
      data-share-manage-status={item.status}
      aria-busy={pending}
      // grid 子项默认 min-width:auto，长标题的 truncate 会把整列撑出窄屏视口。
      className="min-w-0 px-4 py-3"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2
          className="min-w-0 truncate text-ui-base font-medium text-foreground"
          title={item.title}
        >
          {item.title}
        </h2>
        <span
          className={`shrink-0 rounded-lg px-2 py-0.5 text-ui-xs font-medium ${
            revoked
              ? "bg-warning-surface text-warning-surface-foreground"
              : "bg-success-surface text-success-surface-foreground"
          }`}
        >
          {revoked ? copy.statusRevoked : copy.statusActive}
        </span>
      </div>
      <p
        className="mt-1 flex min-w-0 flex-wrap gap-x-1.5 text-ui-sm text-foreground-subtle"
        data-share-manage-summary={item.access_mode}
      >
        <span>{visibility === "private" ? copy.visibilityPrivate : copy.visibilityLink}</span>
        {visibility === "link" ? (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {importPermission === "importable" ? copy.importImportable : copy.importReadonly}
            </span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <span data-share-manage-expires-at={item.expires_at} title={expiresAtText}>
          {formatRemaining(copy, item.expires_at)}
        </span>
      </p>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtlest">
          {copy.createdAt.replace("{time}", formatTime(item.created_at, locale))}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            disabled={pending}
            onClick={handleCopy}
            aria-label={copyLabel}
            title={copyLabel}
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          </Button>
          <Button asChild variant="ghost" size="icon">
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={copy.open}
              title={copy.open}
            >
              <ArrowUpRightIcon aria-hidden="true" />
            </a>
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={pending}
                aria-label={copy.more}
                title={copy.more}
                data-share-manage-more="true"
              >
                <EllipsisIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-share-manage-menu="true">
              {/* 三组设置平铺而不用子菜单：320px 下父菜单两侧都放不下子菜单，子菜单会被推出视口。 */}
              <DropdownMenuLabel className={MENU_GROUP_LABEL_CLASS}>
                {copy.visibilityLabel}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={visibility}
                data-share-manage-visibility="true"
                onValueChange={(value) => {
                  if (value === visibility) return;
                  // 扩大可见范围要二次确认；收窄到仅自己直接生效。
                  if (value === "link") onConfirm({ kind: "make_public", item });
                  else onUpdate({ access_mode: "private" });
                }}
              >
                <DropdownMenuRadioItem value="private">
                  {copy.visibilityPrivate}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="link">{copy.visibilityLink}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className={MENU_GROUP_LABEL_CLASS}>
                {copy.importLabel}
              </DropdownMenuLabel>
              {/* 仅自己时 owner 本来就能导入，「导入权限」对外无意义，禁用避免误解。 */}
              <DropdownMenuRadioGroup
                value={importPermission}
                data-share-manage-import="true"
                onValueChange={(value) => {
                  if (value === importPermission) return;
                  onUpdate({
                    access_mode: value === "importable" ? "public_importable" : "public_readonly",
                  });
                }}
              >
                <DropdownMenuRadioItem value="readonly" disabled={visibility === "private"}>
                  {copy.importReadonly}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="importable" disabled={visibility === "private"}>
                  {copy.importImportable}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              {ttlChoices.length > 0 ? (
                <>
                  <DropdownMenuLabel className={MENU_GROUP_LABEL_CLASS}>
                    {copy.expiryLabel}
                  </DropdownMenuLabel>
                  {/* 有效期是一次性动作而不是持久选项：每次选择都从现在起重新计算，因此不标记选中值。 */}
                  <DropdownMenuGroup data-share-manage-expiry="true">
                    {ttlChoices.map((ttlMs) => (
                      <DropdownMenuItem
                        key={ttlMs}
                        data-share-manage-ttl={ttlMs}
                        onSelect={() => onUpdate({ ttl_ms: ttlMs })}
                      >
                        {formatTtl(copy, ttlMs)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {revoked ? (
                <DropdownMenuItem onSelect={onRestore}>
                  <RotateCcwIcon aria-hidden="true" />
                  {copy.restore}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onConfirm({ kind: "revoke", item })}>
                  <CircleXIcon aria-hidden="true" />
                  {copy.revoke}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onConfirm({ kind: "delete", item })}
              >
                <Trash2Icon aria-hidden="true" />
                {copy.remove}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function ConversationShareManageLoader({
  client,
  getAccessToken,
  onLogin,
  onLogout,
  locale,
  theme,
}: {
  client: ConversationShareManageApi;
  getAccessToken: () => string | null;
  onLogin: (provider: WebOAuthProviderId) => void;
  onLogout: () => void;
  locale: ConversationShareLandingLocale;
  theme?: Theme;
}) {
  const copy = COPY[locale];
  // 列表、分页游标、行状态与确认对话框都只由本组件持有；服务端响应是唯一事实源，不做乐观更新。
  const [state, setState] = useState<
    Exclude<ConversationShareLandingState, { kind: "ready" }> | { kind: "ready" }
  >({
    kind: "loading",
  });
  const [items, setItems] = useState<ConversationShareManagedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  // Bugfix：菜单原先列出全部预设，超出服务端上限必然 3001；范围只来自 capabilities，返回前为空即隐藏分组。
  const [ttlChoices, setTtlChoices] = useState<readonly number[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [activeTheme, setActiveTheme] = useState<Theme>(theme ?? "zai-light");

  useEffect(() => {
    document.title = `${copy.pageTitle} · ${copy.brand}`;
  }, [copy.brand, copy.pageTitle]);

  const handleThemeChange = useCallback((nextTheme: Theme) => {
    localStorage.setItem("zcode-theme", nextTheme);
    setActiveTheme(nextTheme);
    applyTheme(nextTheme);
  }, []);

  const requireSignedOut = useCallback(() => {
    onLogout();
    setState({ kind: "login_required" });
  }, [onLogout]);

  const loadFirstPage = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      setState({ kind: "login_required" });
      return;
    }
    setState({ kind: "loading" });
    // Bugfix：capabilities 原先与列表同在 Promise.all 里，它慢或挂起时列表一直 loading。有效期只用于菜单，
    // 所以单独请求不阻塞列表；返回时 token 已变（重新登录或换号）则丢弃，避免旧账号的范围写到新列表。
    client.ttlOptions(token).then(
      (ttlOptions) => {
        if (getAccessToken() !== token) return;
        setTtlChoices(ttlOptions ? conversationShareTtlChoices(ttlOptions) : []);
      },
      (error: unknown) => {
        if (getAccessToken() !== token) return;
        logManageFailure("capabilities", error);
        if (errorKindOf(error) === "authentication_required") requireSignedOut();
      },
    );
    // Bugfix：capabilities 先返回 401 时 requireSignedOut 已清理登录态并显示登录页，但并行的列表
    // 原先返回后无条件 setState(ready)，把旧 token 的列表重新显示出来。token 是登录态的唯一事实源，
    // 列表与 capabilities 用同一个判断：返回时 token 已不是发请求时的 token，成功和失败都丢弃。
    try {
      const page = await client.list(token);
      if (getAccessToken() !== token) return;
      setItems(page.items);
      setNextCursor(page.next_cursor);
      setState({ kind: "ready" });
    } catch (error) {
      if (getAccessToken() !== token) return;
      logManageFailure("list", error);
      const kind = errorKindOf(error);
      if (kind === "authentication_required") {
        requireSignedOut();
        return;
      }
      const failure = error as Partial<ConversationSharePreviewClientError> | null;
      setState({
        kind: "error",
        error: kind,
        status: failure?.status,
        code: failure?.code,
        requestId: failure?.requestId,
      });
    }
  }, [client, getAccessToken, requireSignedOut]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    const token = getAccessToken();
    if (!token || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const page = await client.list(token, nextCursor);
      setItems((current) => {
        const seen = new Set(current.map((item) => item.share_id));
        return [...current, ...page.items.filter((item) => !seen.has(item.share_id))];
      });
      setNextCursor(page.next_cursor);
    } catch (error) {
      logManageFailure("list_more", error);
      if (errorKindOf(error) === "authentication_required") requireSignedOut();
      else setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [client, getAccessToken, loadingMore, nextCursor, requireSignedOut]);

  const runRowOperation = useCallback(
    async (
      operation: string,
      shareId: string,
      run: (token: string) => Promise<ConversationShareManagedItem | null>,
    ) => {
      const token = getAccessToken();
      if (!token) {
        setState({ kind: "login_required" });
        return;
      }
      setPendingIds((current) => new Set(current).add(shareId));
      setRowErrors(({ [shareId]: _cleared, ...rest }) => rest);
      setNotice(null);
      try {
        const result = await run(token);
        setItems((current) =>
          result
            ? current.map((item) => (item.share_id === shareId ? result : item))
            : current.filter((item) => item.share_id !== shareId),
        );
      } catch (error) {
        logManageFailure(operation, error);
        const kind = errorKindOf(error);
        if (kind === "authentication_required") {
          requireSignedOut();
        } else if (kind === "not_found" || kind === "expired") {
          // 已过期或已不存在的分享不再可管理，按服务端结论从列表移除。
          setItems((current) => current.filter((item) => item.share_id !== shareId));
          setNotice(copy.rowRemovedNotice);
        } else {
          setRowErrors((current) => ({
            ...current,
            [shareId]: kind === "rate_limited" ? copy.rowRateLimited : copy.rowFailed,
          }));
        }
      } finally {
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(shareId);
          return next;
        });
      }
    },
    [copy.rowFailed, copy.rowRateLimited, copy.rowRemovedNotice, getAccessToken, requireSignedOut],
  );

  const handleConfirm = () => {
    if (!confirm) return;
    const { item } = confirm;
    setConfirm(null);
    if (confirm.kind === "make_public") {
      void runRowOperation("update", item.share_id, (token) =>
        client.update(token, item.share_id, { access_mode: "public_readonly" }),
      );
    } else if (confirm.kind === "revoke") {
      void runRowOperation("revoke", item.share_id, (token) => client.revoke(token, item.share_id));
    } else {
      void runRowOperation("delete", item.share_id, async (token) => {
        await client.remove(token, item.share_id);
        return null;
      });
    }
  };

  if (state.kind !== "ready") {
    return (
      <ConversationShareLandingStatus
        state={state}
        locale={locale}
        onLogin={onLogin}
        onRetry={() => void loadFirstPage()}
        loginCopy={{ title: copy.loginTitle, description: copy.loginDescription }}
      />
    );
  }

  const confirmCopy = confirm
    ? confirm.kind === "make_public"
      ? {
          title: copy.makePublicTitle,
          description: copy.makePublicDescription,
          action: copy.makePublicConfirm,
        }
      : confirm.kind === "revoke"
        ? { title: copy.revokeTitle, description: copy.revokeDescription, action: copy.revoke }
        : { title: copy.removeTitle, description: copy.removeDescription, action: copy.remove }
    : null;

  return (
    <main
      className="h-full min-h-0 overflow-x-hidden overflow-y-auto bg-background text-foreground [scrollbar-gutter:stable]"
      data-share-manage-page="true"
    >
      <header className="sticky top-0 z-20 border-b border-border bg-background">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center gap-4 px-4 sm:px-8">
          {/* 与分享落地页同一套品牌组合（图标 + 字标，16px 后接标题），不再用纯文字「ZCode /」。 */}
          <div
            data-share-manage-brand="true"
            className="flex shrink-0 items-center gap-2 text-foreground"
            aria-label={copy.brand}
          >
            <ShareBrandMark />
          </div>
          <h1 className="min-w-0 flex-1 truncate text-ui-lg font-medium">{copy.pageTitle}</h1>
          <ShareThemeToggle theme={activeTheme} copy={copy} onThemeChange={handleThemeChange} />
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8">
        {notice ? (
          <p role="status" className="mb-4 text-ui-sm text-foreground-subtle">
            {notice}
          </p>
        ) : null}
        {items.length === 0 ? (
          <section className="rounded-xl border border-card-border bg-card p-6">
            <h2 className="text-ui-base font-medium">{copy.emptyTitle}</h2>
            <p className="mt-2 text-ui-sm text-foreground-subtle">{copy.emptyDescription}</p>
          </section>
        ) : (
          <ul
            className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-card-border bg-card"
            data-share-manage-list="true"
          >
            {items.map((item) => (
              <ManagedShareRow
                key={item.share_id}
                item={item}
                copy={copy}
                locale={locale}
                pending={pendingIds.has(item.share_id)}
                error={rowErrors[item.share_id]}
                onConfirm={setConfirm}
                ttlChoices={ttlChoices}
                onUpdate={(change) =>
                  void runRowOperation("update", item.share_id, (token) =>
                    client.update(token, item.share_id, change),
                  )
                }
                onRestore={() =>
                  void runRowOperation("restore", item.share_id, (token) =>
                    client.restore(token, item.share_id),
                  )
                }
              />
            ))}
          </ul>
        )}
        {nextCursor ? (
          <div className="mt-4 flex flex-col items-center gap-2">
            <Button
              variant="outline"
              size="lg"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              data-share-manage-load-more="true"
            >
              {loadingMore ? copy.loadingMore : copy.loadMore}
            </Button>
            {loadMoreError ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {copy.loadMoreFailed}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent data-share-manage-confirm={confirm?.kind}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmCopy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmCopy?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.kind === "make_public" ? "default" : "destructive"}
              onClick={handleConfirm}
            >
              {confirmCopy?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
