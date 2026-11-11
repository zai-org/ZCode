import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { Locale } from "@zcode/shared";
import { DEFAULT_LOCALE, isLocale, resolveLocaleFromLanguageTag } from "@zcode/shared";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { LOCALE_MESSAGES } from "@/i18n/localeMessages.js";
import { logger } from "@/logger.js";
import { reportReactErrorToArms } from "@/lib/reactErrorArmsTelemetry.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { AlertTriangleIcon, RefreshCw } from "lucide-react";

interface AppErrorBoundaryProps {
  children: ReactNode;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  /**
   * React 错误边界捕获的异常不会冒泡到 window.onerror，监控 SDK默认收不到。
   * Desktop 等宿主可传入此回调，将 React 错误边界捕获的异常转发到监控 SDK。
   */
  onCaughtReactError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface AppErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

export type ScopedErrorBoundaryVariant = "panel" | "inline" | "compact" | "silent";

interface ScopedErrorBoundaryProps {
  children: ReactNode;
  scope: string;
  resetKeys?: readonly unknown[];
  variant?: ScopedErrorBoundaryVariant;
  className?: string;
  onReset?: () => void;
  onCaughtReactError?: (error: Error, errorInfo: ErrorInfo, scope: string) => void;
}

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

function serializeErrorForLog(error: Error): {
  name: string;
  message: string;
  stack?: string;
} {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

function resolveBoundaryLocale(): Locale {
  if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
    try {
      const storedPreference = localStorage.getItem(LOCALE_PREFERENCE_KEY);
      if (isLocale(storedPreference)) {
        return storedPreference;
      }
    } catch {
      // 在 Node 测试环境里，可能出现“localStorage 对象存在但能力不完整/不可读”的场景
      // （例如只有占位对象或读取阶段直接抛错）。错误边界若不兜底会在 fallback 渲染期再次崩溃，
      // 用户就会看到白屏。这里吞掉存储层异常，继续回退到 navigator / 默认语言。
    }
  }

  if (typeof navigator !== "undefined") {
    return resolveLocaleFromLanguageTag(navigator.language);
  }

  return DEFAULT_LOCALE;
}

function formatBoundaryMessage(id: string): string {
  const locale = resolveBoundaryLocale();
  const messages = LOCALE_MESSAGES[locale];
  return messages[id] ?? id;
}

function haveResetKeysChanged(
  previousKeys: readonly unknown[] = [],
  nextKeys: readonly unknown[] = [],
): boolean {
  if (previousKeys.length !== nextKeys.length) {
    return true;
  }

  return previousKeys.some((previousKey, index) => !Object.is(previousKey, nextKeys[index]));
}

function ErrorFallback({
  error,
  componentStack,
  onReset,
  onReload,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
}: {
  error: Error;
  componentStack: string;
  onReset: () => void;
  onReload: () => void;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const errorSummary = error.message.trim() || formatBoundaryMessage("appError.unknown");

  return (
    <DesktopWindowFrame
      title={formatBoundaryMessage("appError.title")}
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
    >
      <div className="flex h-full min-h-0 justify-center overflow-y-auto p-6">
        <div
          role="alert"
          // 错误信息和组件堆栈可能非常长，之前外层不可滚动会把内容挤出视口，
          // 用户既看不完堆栈，也点不到“重试/刷新”按钮。这里让 fallback 卡片固定从顶部开始，
          // 并配合外层纵向滚动，确保窗口再小也能完整访问全部操作。
          className="w-full max-w-xl self-start rounded-3xl border border-destructive/20 bg-surface-alt p-6 shadow-sm"
        >
          <div className="flex size-10 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <AlertTriangleIcon className="size-5" />
          </div>

          <h1 className="mt-4 text-lg font-semibold text-foreground">
            {formatBoundaryMessage("appError.title")}
          </h1>
          <p className="mt-2 text-ui-base leading-6 text-on-surface-muted">
            {formatBoundaryMessage("appError.description")}
          </p>

          <div className="mt-4 rounded-2xl border border-border bg-background px-3 py-2 font-mono text-ui-base leading-5 text-on-surface-muted">
            {errorSummary}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button type="button" onClick={onReset}>
              {formatBoundaryMessage("appError.retry")}
            </Button>
            <Button type="button" variant="outline" onClick={onReload}>
              <RefreshCw />
              {formatBoundaryMessage("appError.reload")}
            </Button>
          </div>

          <p className="mt-4 text-ui-base leading-5 text-on-surface-muted">
            {formatBoundaryMessage("appError.hint")}
          </p>

          {componentStack ? (
            <details className="mt-4 rounded-2xl border border-border bg-background px-3 py-2">
              <summary className="cursor-pointer text-ui-base font-medium text-on-surface-muted">
                {formatBoundaryMessage("appError.details")}
              </summary>
              <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-ui-base leading-5 text-on-surface-muted">
                {/* 组件堆栈展开后会瞬间增高，限制 pre 高度并独立滚动，
                    避免 details 撑满全屏导致主操作区被挤出可视区域。 */}
                {componentStack.trim()}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </DesktopWindowFrame>
  );
}

function ScopedErrorFallback({
  error,
  componentStack,
  onReset,
  onReload,
  variant = "panel",
  className,
}: {
  error: Error;
  componentStack: string;
  onReset: () => void;
  onReload: () => void;
  variant?: ScopedErrorBoundaryVariant;
  className?: string;
}) {
  if (variant === "silent") {
    return null;
  }

  const errorSummary = error.message.trim() || formatBoundaryMessage("appError.unknown");
  const isCompact = variant === "compact";
  const showDetails = variant !== "compact";

  if (isCompact) {
    return (
      <div
        role="alert"
        className={cn(
          "flex min-h-10 items-center gap-2 border-border bg-surface px-3 py-2",
          className,
        )}
      >
        <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base font-medium text-foreground">
            {formatBoundaryMessage("appError.sectionTitle")}
          </p>
          <p className="truncate font-mono text-ui-base text-foreground-subtle">{errorSummary}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onReset}>
          {formatBoundaryMessage("appError.sectionRetry")}
        </Button>
      </div>
    );
  }

  const content = (
    <>
      <div className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <AlertTriangleIcon className="size-4" />
      </div>
      <h2 className="mt-3 text-ui-base font-medium text-foreground">
        {formatBoundaryMessage("appError.sectionTitle")}
      </h2>
      <p className="mt-1 text-ui-base leading-5 text-foreground-subtle">
        {formatBoundaryMessage("appError.sectionDescription")}
      </p>
      <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2 font-mono text-ui-base leading-5 text-foreground-subtle">
        {errorSummary}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onReset}>
          {formatBoundaryMessage("appError.sectionRetry")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReload}>
          <RefreshCw />
          {formatBoundaryMessage("appError.reload")}
        </Button>
      </div>
      <p className="mt-3 text-ui-base leading-5 text-foreground-subtle">
        {formatBoundaryMessage("appError.sectionHint")}
      </p>
      {showDetails && componentStack ? (
        <details className="mt-3 rounded-lg border border-border bg-background px-3 py-2">
          <summary className="cursor-pointer text-ui-base font-medium text-foreground-subtle">
            {formatBoundaryMessage("appError.details")}
          </summary>
          <pre className="mt-2 max-h-[32vh] overflow-auto whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground-subtle">
            {componentStack.trim()}
          </pre>
        </details>
      ) : null}
    </>
  );

  if (variant === "inline") {
    return (
      <div
        role="alert"
        className={cn("w-full rounded-xl border border-destructive/20 bg-surface p-4", className)}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-4",
        className,
      )}
    >
      <div className="w-full max-w-md rounded-xl border border-destructive/20 bg-surface p-4 shadow-sm">
        {content}
      </div>
    </div>
  );
}

/**
 * AppErrorBoundary —— React 根级错误边界
 *
 * renderer 入口若直接把 ZCodeIntlProvider / Root 挂到 createRoot，
 * 一旦某个 Provider 或页面组件在 render / lifecycle 阶段抛错，React 会整棵树卸载，
 * 用户看到的就只剩一张白屏。这里包一层共享根级边界，把异常收敛成可恢复 fallback，
 * 至少保证界面还能给出“重试 / 刷新”的出口，并把错误打到统一 UI 日志里。
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: normalizeError(error),
      componentStack: "",
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeError(error);
    logger.error(
      "[AppErrorBoundary] React subtree crashed:",
      // Error 对象跨 preload 日志 bridge 序列化后会变成 {}，
      // 导致 Maximum update depth 等关键 message 丢失。这里显式展开可诊断字段。
      serializeErrorForLog(normalizedError),
      errorInfo.componentStack,
    );
    this.props.onCaughtReactError?.(normalizedError, errorInfo);
    // React 错误边界拦截了异常、阻止其冒泡到 window.onerror，RUM Browser SDK 默认收不到。
    // 主动转发到 ARMS 自定义事件干道（reporter 在 renderer 入口早注入），补上根级渲染崩溃盲区。
    reportReactErrorToArms({
      error: normalizedError,
      componentStack: errorInfo.componentStack ?? "",
    });
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
  }

  private handleReset = () => {
    this.setState({
      error: null,
      componentStack: "",
    });
  };

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <ErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReset={this.handleReset}
        onReload={this.handleReload}
        isDesktop={this.props.isDesktop}
        isMacDesktop={this.props.isMacDesktop}
        isWindowsDesktop={this.props.isWindowsDesktop}
      />
    );
  }
}

/**
 * ScopedErrorBoundary —— 局部 UI 故障隔离边界
 *
 * 只有根级错误边界时，workspace 内任意一个面板 render 抛错都会一路冒泡到根，
 * 最终把整套界面替换成全屏错误页。这里提供可复用的局部边界，让 sidebar、chat、
 * terminal、side pane 等区域各自失败各自恢复，避免单个组件问题扩大成整窗不可用。
 */
export class ScopedErrorBoundary extends Component<
  ScopedErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: normalizeError(error),
      componentStack: "",
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeError(error);
    logger.error(
      `[ScopedErrorBoundary:${this.props.scope}] React subtree crashed:`,
      // Error 对象跨 preload 日志 bridge 序列化后会变成 {}，
      // 局部边界需要保留 message/stack 才能定位 UI 更新循环。
      serializeErrorForLog(normalizedError),
      errorInfo.componentStack,
    );
    this.props.onCaughtReactError?.(normalizedError, errorInfo, this.props.scope);
    // 同根级边界：scoped 区域捕获的渲染异常同样不会冒泡到 RUM，按 scope 区分上报，
    // 让 sidebar/chat/terminal/settings 等局部崩溃在 RUM 里可见、可定位。
    reportReactErrorToArms({
      error: normalizedError,
      componentStack: errorInfo.componentStack ?? "",
      scope: this.props.scope,
    });
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
  }

  override componentDidUpdate(previousProps: ScopedErrorBoundaryProps) {
    if (this.state.error && haveResetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      // 局部 fallback 如果不随 workspace/task/tab 切换自动清空，
      // 用户离开出错区域后再回来仍会看到旧错误。resetKeys 变化时重置边界，
      // 让新的隔离上下文可以重新渲染。
      this.setState({
        error: null,
        componentStack: "",
      });
    }
  }

  private handleReset = () => {
    this.setState({
      error: null,
      componentStack: "",
    });
    this.props.onReset?.();
  };

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <ScopedErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReset={this.handleReset}
        onReload={this.handleReload}
        variant={this.props.variant}
        className={this.props.className}
      />
    );
  }
}
