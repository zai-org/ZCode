/**
 * 草稿态空态问候：时间问候语 + ZCode Logo。
 * 自旧版 ChatView/ChatViewEmptyState.tsx 恢复（该组件随旧 ChatView 删除，
 * i18n key `chat.empty.greeting.*` 一直保留）；边界时刻自动换档逻辑保真。
 * 手机远控复用同一组件，但继续保留 20px 紧凑标题；桌面草稿首页才按标题自身宽度适配。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import darkEmptyStateLogoUrl from "@/assets/Z.svg";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";

const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;
const GREETING_MIN_FONT_SIZE_PX = 20;
const GREETING_MAX_FONT_SIZE_PX = 30;

export type ChatEmptyGreetingMessageId =
  | "chat.empty.greeting.morningEarly"
  | "chat.empty.greeting.morning"
  | "chat.empty.greeting.noon"
  | "chat.empty.greeting.afternoon"
  | "chat.empty.greeting.evening"
  | "chat.empty.greeting.lateNight";

export function getChatEmptyGreetingMessageId(date: Date = new Date()): ChatEmptyGreetingMessageId {
  const hour = date.getHours();

  if (hour >= 5 && hour < 9) return "chat.empty.greeting.morningEarly";
  if (hour >= 9 && hour < 12) return "chat.empty.greeting.morning";
  if (hour >= 12 && hour < 14) return "chat.empty.greeting.noon";
  if (hour >= 14 && hour < 18) return "chat.empty.greeting.afternoon";
  if (hour >= 18 && hour < 23) return "chat.empty.greeting.evening";

  return "chat.empty.greeting.lateNight";
}

export function getNextChatEmptyGreetingDelayMs(date: Date = new Date()) {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date);
    boundary.setHours(hour, 0, 0, 0);
    return boundary;
  });
  const tomorrowFirstBoundary = new Date(date);
  tomorrowFirstBoundary.setDate(tomorrowFirstBoundary.getDate() + 1);
  tomorrowFirstBoundary.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0);

  const nextBoundary =
    candidates.find((candidate) => candidate.getTime() > date.getTime()) ?? tomorrowFirstBoundary;

  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

export function resolveGreetingFontSizePx({
  availableWidthPx,
  naturalTextWidthPx,
  compactForRemoteControl = false,
}: {
  availableWidthPx: number;
  naturalTextWidthPx: number;
  compactForRemoteControl?: boolean;
}) {
  if (compactForRemoteControl) {
    return GREETING_MIN_FONT_SIZE_PX;
  }
  if (
    !Number.isFinite(availableWidthPx) ||
    !Number.isFinite(naturalTextWidthPx) ||
    availableWidthPx <= 0 ||
    naturalTextWidthPx <= 0 ||
    availableWidthPx >= naturalTextWidthPx
  ) {
    return GREETING_MAX_FONT_SIZE_PX;
  }

  return Math.max(
    GREETING_MIN_FONT_SIZE_PX,
    Math.min(
      GREETING_MAX_FONT_SIZE_PX,
      Math.floor(GREETING_MAX_FONT_SIZE_PX * (availableWidthPx / naturalTextWidthPx)),
    ),
  );
}

export function ConversationDraftEmptyState({
  className,
  compactForRemoteControl = false,
}: {
  className?: string;
  compactForRemoteControl?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const [greetingDate, setGreetingDate] = useState(() => new Date());
  const greetingContainerRef = useRef<HTMLParagraphElement | null>(null);
  const greetingMeasurementRef = useRef<HTMLSpanElement | null>(null);
  const greeting = intl.formatMessage({
    id: isOfficeMode ? "chat.empty.greeting.office" : getChatEmptyGreetingMessageId(greetingDate),
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setGreetingDate(new Date());
    }, getNextChatEmptyGreetingDelayMs(greetingDate));

    return () => {
      window.clearTimeout(timeout);
    };
  }, [greetingDate]);

  useLayoutEffect(() => {
    if (compactForRemoteControl) {
      return;
    }
    const container = greetingContainerRef.current;
    const measurement = greetingMeasurementRef.current;
    if (!container || !measurement) {
      return;
    }

    const measure = () => {
      const containerStyle = window.getComputedStyle(container);
      const horizontalPaddingPx =
        Number.parseFloat(containerStyle.paddingLeft) +
        Number.parseFloat(containerStyle.paddingRight);
      const availableWidthPx = Math.max(
        0,
        container.getBoundingClientRect().width - horizontalPaddingPx,
      );
      const naturalTextWidthPx = measurement.getBoundingClientRect().width;
      const nextFontSizePx = resolveGreetingFontSizePx({
        availableWidthPx,
        naturalTextWidthPx,
      });

      const nextFontSize = `${nextFontSizePx}px`;
      if (container.style.getPropertyValue("--v4-draft-greeting-font-size") === nextFontSize) {
        return;
      }
      // Bugfix：侧栏收窄时，RO → RAF → React state 会先画出旧字号的两行标题，
      // 把输入框推下再弹回。字号只属于 DOM 投影，必须在本次绘制前直接适配。
      container.style.setProperty("--v4-draft-greeting-font-size", nextFontSize);
      logger.debug("[v4-draft-greeting] 标题自身可用宽度变化，更新字号", {
        availableWidthPx: Math.round(availableWidthPx),
        naturalTextWidthPx: Math.round(naturalTextWidthPx),
        nextFontSizePx,
      });
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
      };
    }

    // 标题字号曾直接绑定整个视口宽度，最小窗口里文字两侧仍有大量空间却被
    // 强制缩到 20px。分别观察标题容器和 30px 原始文案，只在两者真实相撞时缩小。
    const observer = new ResizeObserver(measure);
    // 可见标题的高度会随字号改变；观察它会让同步适配反过来触发 RO 循环。
    // 隐藏测量区字号固定，分别提供可用宽度和原始文案宽度，不受适配结果影响。
    observer.observe(measurement.parentElement!);
    observer.observe(measurement);
    return () => {
      observer.disconnect();
    };
  }, [compactForRemoteControl, greeting]);

  return (
    <div
      className={cn(
        "relative mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 text-foreground sm:mb-8",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(72vw,25rem)] -mt-10",
          "-translate-x-1/2 -translate-y-1/2 text-foreground-subtlest",
        )}
      >
        <ZCodeEmptyStateLogo className="h-full w-full" />
      </div>
      <p
        ref={greetingContainerRef}
        data-v4-draft-greeting="true"
        className={cn(
          "relative z-10 w-full px-4 text-center font-medium text-foreground",
          compactForRemoteControl
            ? "text-xl/[1.2]"
            : "text-[length:var(--v4-draft-greeting-font-size,30px)]/[1.2]",
        )}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-x-4 whitespace-nowrap text-3xl/[1.2]"
        >
          <span ref={greetingMeasurementRef} className="inline-block">
            {greeting}
          </span>
        </span>
        <span>{greeting}</span>
      </p>
    </div>
  );
}

function ZCodeEmptyStateLogo({ className }: { className?: string }) {
  return (
    <>
      {/* 修复原因：夜间资源已自带渐变和透明度，公共容器叠加遮罩会让它重复变淡；渐隐效果只属于浅色线框。 */}
      <svg
        aria-hidden="true"
        className={cn(
          className,
          "opacity-70 dark:hidden",
          "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
          "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
          "[mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
          "[mask-repeat:no-repeat] [mask-size:100%_100%]",
        )}
        width="400"
        height="320"
        viewBox="0 0 400 320"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M398.97 0.5L147.576 319.5H1.03027L37.5996 273.081L120.167 169.603L120.171 169.598L215.342 47.5605L215.343 47.5615L252.424 0.5H398.97ZM264.544 273.271H372.527L336.082 319.498H189.886L202.642 303.307C217.584 284.34 240.398 273.271 264.544 273.271ZM209.164 0.5L202.786 8.58887C183.782 32.6885 154.782 46.752 124.091 46.752H25.9805L62.4268 0.5H209.164Z"
          stroke="currentColor"
        />
      </svg>
      {/* 深色资源包含专用渐变与模糊效果，不能通过 currentColor 复刻；主题类保证两套 Logo 互斥显示。 */}
      <img
        aria-hidden="true"
        className={cn(className, "hidden dark:block")}
        data-v4-draft-logo="dark"
        src={darkEmptyStateLogoUrl}
        alt=""
      />
    </>
  );
}
