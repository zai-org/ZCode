import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleXIcon,
  CopyIcon,
  EllipsisIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { localizeConversationShareUrl, type ConversationShareManagedItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getConversationShareErrorDetails } from "@/lib/conversationShareError.js";
import { logger } from "@/logger.js";

export interface SettingsShareTaskTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export interface SettingsShareManagementProps {
  /** 桌面登录态；未登录时只显示登录提示，不请求管理 API。 */
  signedIn: boolean;
  onLogin?: () => void;
  onOpenTask?: (target: SettingsShareTaskTarget) => void;
}

type ConfirmAction = { kind: "revoke" | "delete"; item: ConversationShareManagedItem };
type LoadState = "loading" | "ready" | "login_required" | "error";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COPIED_FEEDBACK_MS = 1500;

function useMessage() {
  const { intl, locale } = useZCodeIntl();
  const msg = useCallback(
    (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id: `conversationShare.manage.${id}` }, values),
    [intl],
  );
  return { msg, locale };
}

// 只用于展示：过期判定以服务端为准，这里不据此隐藏或改状态。
// 文案只支持 {key} 替换、没有复数规则，所以单复数用不同的 key。
function remainingMessage(expiresAt: number): { id: string; count?: number } {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs >= DAY_MS) {
    const count = Math.floor(remainingMs / DAY_MS);
    return count === 1 ? { id: "remainingDay" } : { id: "remainingDays", count };
  }
  if (remainingMs >= HOUR_MS) {
    const count = Math.floor(remainingMs / HOUR_MS);
    return count === 1 ? { id: "remainingHour" } : { id: "remainingHours", count };
  }
  return { id: "remainingLessThanHour" };
}

function logManageFailure(operation: string, error: unknown): void {
  // 只记录稳定字段：不记录 JWT、分享码或响应正文。
  const details = getConversationShareErrorDetails(error);
  logger.warn("[conversation-share-manage] operation failed", {
    operation,
    kind: details.kind,
    status: details.status,
    code: details.code,
    requestId: details.requestId,
  });
}

function ManagedShareRow({
  item,
  pending,
  error,
  target,
  onOpenTask,
  onConfirm,
  onRestore,
}: {
  item: ConversationShareManagedItem;
  pending: boolean;
  error?: string;
  target?: SettingsShareTaskTarget;
  onOpenTask?: (target: SettingsShareTaskTarget) => void;
  onConfirm: (action: ConfirmAction) => void;
  onRestore: () => void;
}) {
  const { msg, locale } = useMessage();
  const platform = usePlatform();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const shareUrl = localizeConversationShareUrl(item.share_url, locale);
  const revoked = item.status === "revoked";
  const remaining = remainingMessage(item.expires_at);
  const formatTime = (timestamp: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(timestamp),
    );
  const copyLabel = msg(copied ? "copied" : "copyLink");

  const handleCopy = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  };

  return (
    <li
      data-testid="share-management-item"
      data-share-id={item.share_id}
      data-share-status={item.status}
      aria-busy={pending}
      className="min-w-0 px-4 py-3"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3
          className="min-w-0 truncate text-ui-base font-medium text-foreground"
          title={item.title}
        >
          {item.title}
        </h3>
        <span
          className={`shrink-0 rounded-lg px-2 py-0.5 text-ui-xs font-medium ${
            revoked
              ? "bg-warning-surface text-warning-surface-foreground"
              : "bg-success-surface text-success-surface-foreground"
          }`}
        >
          {msg(revoked ? "statusRevoked" : "statusActive")}
        </span>
      </div>
      <p
        className="mt-1 flex min-w-0 flex-wrap gap-x-1.5 text-ui-sm text-foreground-subtle"
        data-testid="share-management-summary"
      >
        <span>{msg(item.access_mode === "private" ? "visibilityPrivate" : "visibilityLink")}</span>
        {item.access_mode === "private" ? null : (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {msg(
                item.access_mode === "public_importable" ? "importImportable" : "importReadonly",
              )}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span title={msg("expiresAt", { time: formatTime(item.expires_at) })}>
          {msg(
            remaining.id,
            remaining.count === undefined ? undefined : { count: remaining.count },
          )}
        </span>
      </p>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtlest">
          {msg("createdAt", { time: formatTime(item.created_at) })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {target && onOpenTask ? (
            <Button
              variant="ghost"
              size="icon"
              disabled={pending}
              aria-label={msg("openConversation")}
              title={msg("openConversation")}
              data-testid="share-management-open-conversation"
              onClick={() => onOpenTask(target)}
            >
              <MessageSquareIcon aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            disabled={pending}
            aria-label={copyLabel}
            title={copyLabel}
            data-testid="share-management-copy"
            onClick={handleCopy}
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={msg("open")}
            title={msg("open")}
            data-testid="share-management-open"
            onClick={() => platform.openExternal(shareUrl)}
          >
            <ArrowUpRightIcon aria-hidden="true" />
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={pending}
                aria-label={msg("more")}
                title={msg("more")}
                data-testid="share-management-more"
              >
                <EllipsisIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid="share-management-menu">
              {revoked ? (
                <DropdownMenuItem data-testid="share-management-restore" onSelect={onRestore}>
                  <RotateCcwIcon aria-hidden="true" />
                  {msg("restore")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  data-testid="share-management-revoke"
                  onSelect={() => onConfirm({ kind: "revoke", item })}
                >
                  <CircleXIcon aria-hidden="true" />
                  {msg("revoke")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                data-testid="share-management-delete"
                onSelect={() => onConfirm({ kind: "delete", item })}
              >
                <Trash2Icon aria-hidden="true" />
                {msg("remove")}
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

/**
 * 设置页分享管理（桌面端，只读权限与有效期）。
 * 列表、分页游标、行状态与确认对话框只由本组件持有；服务端响应是唯一事实源，不做乐观更新。
 */
export function SettingsShareManagement({
  signedIn,
  onLogin,
  onOpenTask,
}: SettingsShareManagementProps) {
  const { msg } = useMessage();
  const services = useBaseWorkspaceServices();
  const shareService = services.conversationShareService;
  const controller = services.windowControllerService;
  const [state, setState] = useState<LoadState>(signedIn ? "loading" : "login_required");
  const [items, setItems] = useState<ConversationShareManagedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [targets, setTargets] = useState<Readonly<Record<string, SettingsShareTaskTarget>>>({});
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  // 登录态切换或重新加载后，旧请求的响应不得写回新列表。
  const generationRef = useRef(0);

  // 跳转目标只读 Host 本地索引：命中才显示「跳转对话」，未命中（其他设备、已删除、旧分享）不显示。
  const resolveTargets = useCallback(
    async (page: readonly ConversationShareManagedItem[], generation: number) => {
      const taskIds = [
        ...new Set(
          page.flatMap((item) => (item.source_session_id ? [item.source_session_id] : [])),
        ),
      ];
      if (!controller || taskIds.length === 0) {
        logger.lifecycle.info("[conversation-share-manage] source sessions skipped", {
          pageSize: page.length,
          withSource: taskIds.length,
          hasController: Boolean(controller),
        });
        return;
      }
      try {
        const result = await controller.listTaskList({
          kind: "all",
          workspaceScopes: "host",
          sortBy: "updated",
          taskIds,
        });
        // 每页一次：本页有来源的条数与本机命中数，排查「为何没有跳转」只看这一条。
        logger.lifecycle.info("[conversation-share-manage] source sessions resolved", {
          pageSize: page.length,
          requested: taskIds.length,
          resolved: result.items.length,
        });
        if (generationRef.current !== generation) return;
        setTargets((current) => {
          const next = { ...current };
          for (const task of result.items) {
            next[task.taskId] = {
              workspacePath: task.workspacePath,
              ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
              taskId: task.taskId,
            };
          }
          return next;
        });
      } catch (error) {
        logger.lifecycle.warn("[conversation-share-manage] resolve source sessions failed", {
          count: taskIds.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [controller],
  );

  const handleAuthLost = useCallback(() => {
    generationRef.current += 1;
    setItems([]);
    setNextCursor(undefined);
    setState("login_required");
  }, []);

  const loadFirstPage = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!signedIn) {
      setState("login_required");
      return;
    }
    setState("loading");
    setTargets({});
    try {
      const page = await shareService.listManagedShares({});
      if (generationRef.current !== generation) return;
      setItems(page.items);
      setNextCursor(page.next_cursor);
      setState("ready");
      void resolveTargets(page.items, generation);
    } catch (error) {
      if (generationRef.current !== generation) return;
      logManageFailure("list", error);
      if (getConversationShareErrorDetails(error).kind === "authentication_required") {
        handleAuthLost();
        return;
      }
      setState("error");
    }
  }, [handleAuthLost, resolveTargets, shareService, signedIn]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const page = await shareService.listManagedShares({ cursor: nextCursor });
      if (generationRef.current !== generation) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.share_id));
        return [...current, ...page.items.filter((item) => !seen.has(item.share_id))];
      });
      setNextCursor(page.next_cursor);
      void resolveTargets(page.items, generation);
    } catch (error) {
      logManageFailure("list_more", error);
      // Bugfix：失败分支原先没有代际检查。首屏重新加载后旧的加载更多请求再失败，
      // 会清空新列表（401）或在新列表下显示「加载失败」。与成功分支一样只处理同一代请求。
      if (generationRef.current !== generation) return;
      if (getConversationShareErrorDetails(error).kind === "authentication_required") {
        handleAuthLost();
      } else {
        setLoadMoreError(true);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [handleAuthLost, loadingMore, nextCursor, resolveTargets, shareService]);

  const runRowOperation = useCallback(
    async (
      operation: string,
      shareId: string,
      run: () => Promise<ConversationShareManagedItem | null>,
    ) => {
      const generation = generationRef.current;
      setPendingIds((current) => new Set(current).add(shareId));
      setRowErrors(({ [shareId]: _cleared, ...rest }) => rest);
      setNotice(null);
      try {
        const result = await run();
        if (generationRef.current !== generation) return;
        setItems((current) =>
          result
            ? current.map((item) => (item.share_id === shareId ? result : item))
            : current.filter((item) => item.share_id !== shareId),
        );
      } catch (error) {
        logManageFailure(operation, error);
        if (generationRef.current !== generation) return;
        const kind = getConversationShareErrorDetails(error).kind;
        if (kind === "authentication_required") {
          handleAuthLost();
        } else if (kind === "not_found" || kind === "expired") {
          // 已过期或已不存在的分享不再可管理，按服务端结论从列表移除。
          setItems((current) => current.filter((item) => item.share_id !== shareId));
          setNotice(msg("rowRemovedNotice"));
        } else {
          setRowErrors((current) => ({
            ...current,
            [shareId]: msg(kind === "rate_limited" ? "rowRateLimited" : "rowFailed"),
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
    [handleAuthLost, msg],
  );

  const handleConfirm = () => {
    if (!confirm) return;
    const { item, kind } = confirm;
    setConfirm(null);
    if (kind === "revoke") {
      void runRowOperation("revoke", item.share_id, () =>
        shareService.revokeManagedShare(item.share_id),
      );
    } else {
      void runRowOperation("delete", item.share_id, async () => {
        await shareService.deleteManagedShare(item.share_id);
        return null;
      });
    }
  };

  if (state === "login_required") {
    return (
      <section
        data-testid="share-management"
        data-state="login_required"
        className="rounded-xl border border-card-border bg-card p-6"
      >
        <h2 className="text-ui-base font-medium">{msg("loginTitle")}</h2>
        <p className="mt-2 text-ui-sm text-foreground-subtle">{msg("loginDescription")}</p>
        {onLogin ? (
          <Button className="mt-4" size="lg" onClick={onLogin}>
            {msg("login")}
          </Button>
        ) : signedIn ? (
          // Bugfix：已登录时 Root 不注入 onLogin。服务端 401 通常由 Host 全局登录失效流程清空 user，
          // 页面随之进入未登录分支；但全局流程不触发时（本地取不到 token、401 属于已被替换的旧凭据），
          // signedIn 保持 true、加载依赖不变，页面原先没有任何出口。这里提供重试，重新加载首屏。
          <Button
            className="mt-4"
            variant="outline"
            size="lg"
            data-testid="share-management-retry"
            onClick={() => void loadFirstPage()}
          >
            {msg("retry")}
          </Button>
        ) : null}
      </section>
    );
  }

  if (state !== "ready") {
    return (
      <section
        data-testid="share-management"
        data-state={state}
        className="rounded-xl border border-card-border bg-card p-6"
      >
        <p className="text-ui-sm text-foreground-subtle">
          {msg(state === "loading" ? "loading" : "loadFailed")}
        </p>
        {state === "error" ? (
          <Button className="mt-4" variant="outline" size="lg" onClick={() => void loadFirstPage()}>
            {msg("retry")}
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section data-testid="share-management" data-state="ready" className="min-w-0">
      {notice ? (
        <p role="status" className="mb-4 text-ui-sm text-foreground-subtle">
          {notice}
        </p>
      ) : null}
      {items.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-card p-6">
          <h2 className="text-ui-base font-medium">{msg("emptyTitle")}</h2>
          <p className="mt-2 text-ui-sm text-foreground-subtle">{msg("emptyDescription")}</p>
        </div>
      ) : (
        <ul
          className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-card-border bg-card"
          data-testid="share-management-list"
        >
          {items.map((item) => (
            <ManagedShareRow
              key={item.share_id}
              item={item}
              pending={pendingIds.has(item.share_id)}
              error={rowErrors[item.share_id]}
              target={item.source_session_id ? targets[item.source_session_id] : undefined}
              onOpenTask={onOpenTask}
              onConfirm={setConfirm}
              onRestore={() =>
                void runRowOperation("restore", item.share_id, () =>
                  shareService.restoreManagedShare(item.share_id),
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
            data-testid="share-management-load-more"
          >
            {msg(loadingMore ? "loadingMore" : "loadMore")}
          </Button>
          {loadMoreError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {msg("loadMoreFailed")}
            </p>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent data-testid="share-management-confirm" data-kind={confirm?.kind}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {msg(confirm?.kind === "delete" ? "removeTitle" : "revokeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {msg(confirm?.kind === "delete" ? "removeDescription" : "revokeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{msg("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="share-management-confirm-action"
              onClick={handleConfirm}
            >
              {msg(confirm?.kind === "delete" ? "remove" : "revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
