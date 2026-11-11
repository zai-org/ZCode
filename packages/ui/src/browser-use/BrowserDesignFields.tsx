import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import { parseCssColor, toHexColor } from "@zcode/design-runtime";
import { joinColor, splitColor } from "@/browser-use/browserDesignProperties.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";

// 属性面板的数值 / 颜色字段（docs/browser-use/2026-11-03-browser-design-mode-spec.md 第五节）。
// 数字为主：输入后回车或失焦提交，↑↓ 微调（Shift × 10），拖左侧标签改值（拖动时只预览，松手提交）。
// 纯展示：预览与提交都交给调用方。

export type Translate = (id: string, values?: Record<string, string>) => string;

// 设计面板的属性框：常显边框，悬停 / 聚焦时边框变色
const FIELD_CLASS =
  "flex h-7 min-w-0 items-center rounded-md border border-input-border bg-input text-ui-sm hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused";

const round = (value: number, step: number) => {
  const decimals = String(step).split(".")[1]?.length ?? 0;
  return Number(value.toFixed(decimals));
};

export function NumberField({
  dataAttribute,
  disabled,
  label,
  max = Number.POSITIVE_INFINITY,
  min = 0,
  onCommit,
  onPreview,
  prefix,
  step = 1,
  suffix,
  value,
}: {
  /** 稳定的字段名（E2E 钩子），不随语言变 */
  dataAttribute: Record<string, string>;
  disabled?: boolean;
  label: string;
  max?: number;
  min?: number;
  onCommit: (value: number) => void;
  onPreview?: (value: number) => void;
  /** 左侧可拖动的标签：一个字母或图标；不给时只显示数字 */
  prefix?: ReactNode;
  step?: number;
  suffix?: string;
  value: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (next: number) => round(Math.max(min, Math.min(max, next)), step);
  const startScrub = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    let last = value;
    const move = (moveEvent: PointerEvent) => {
      const delta =
        Math.round((moveEvent.clientX - startX) / 3) * step * (moveEvent.shiftKey ? 10 : 1);
      last = clamp(value + delta);
      onPreview?.(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      if (last !== value) onCommit(last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  // Esc 放弃输入：blur 同步触发 onBlur 时 draft 还没清掉，靠这个标记跳过提交（!3450 CR-03）
  const cancelledRef = useRef(false);
  const commitDraft = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft === null) return;
    setDraft(null);
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed) && clamp(parsed) !== value) onCommit(clamp(parsed));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setDraft(null);
      const next = clamp(
        value + (event.key === "ArrowUp" ? step : -step) * (event.shiftKey ? 10 : 1),
      );
      if (next !== value) onCommit(next);
    } else if (event.key === "Enter") {
      commitDraft();
    } else if (event.key === "Escape") {
      cancelledRef.current = true;
      setDraft(null);
      event.currentTarget.blur();
    }
  };
  return (
    <label className={cn(FIELD_CLASS, disabled && "opacity-60")} title={label}>
      {prefix === undefined ? (
        <span aria-hidden="true" className="w-2 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "grid h-full w-6 shrink-0 place-items-center text-foreground-subtle select-none",
            !disabled && "cursor-ew-resize hover:text-foreground",
          )}
          onPointerDown={startScrub}
        >
          {prefix}
        </span>
      )}
      <input
        {...dataAttribute}
        aria-label={label}
        // 有没提交的输入时 Cmd/Ctrl + Z 撤销打字；否则交给面板撤销上一次写回
        data-design-draft={draft !== null}
        className="h-full w-full min-w-0 bg-transparent tabular-nums outline-none disabled:cursor-not-allowed"
        disabled={disabled}
        inputMode="decimal"
        value={draft ?? String(value)}
        onBlur={commitDraft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {suffix ? <span className="shrink-0 pr-2 text-foreground-subtle">{suffix}</span> : null}
    </label>
  );
}

export interface PaletteColor {
  name: string;
  value: string;
}

/** 颜色：色块（弹出页面颜色 + 自定义）| 十六进制 | 不透明度 %（照 Figma 的 Fill 行） */
export function ColorField({
  dataAttribute,
  disabled,
  label,
  onCommit,
  onPreview,
  palette,
  t,
  value,
}: {
  dataAttribute: Record<string, string>;
  disabled?: boolean;
  label: string;
  onCommit: (value: string) => void;
  onPreview?: (value: string) => void;
  palette: readonly PaletteColor[];
  t: Translate;
  value: string;
}) {
  const { hex, alpha } = splitColor(value);
  const [draft, setDraft] = useState<string | null>(null);
  const [alphaDraft, setAlphaDraft] = useState<string | null>(null);
  // 自定义取色器拖动时只预览，关掉弹层时提交最后的颜色
  const [picked, setPicked] = useState<string | null>(null);
  // 打开弹层时的颜色：预览会让 value 先变成取到的颜色，关闭时要跟打开前比，否则以为没改、不写回（!3450 CR-02）
  const openedHexRef = useRef(hex);
  const openedValueRef = useRef(value);
  const committedInPopoverRef = useRef(false);
  const hexCancelledRef = useRef(false);
  const alphaCancelledRef = useRef(false);
  // 透明（不透明度 0）上换了颜色按 100% 写：否则写进去的是 rgba(…, 0)，看起来什么都没变（!3450 SG-02）
  const commitColor = (nextHex: string, nextAlpha: number) => {
    const changedHex = nextHex.toLowerCase() !== hex.toLowerCase();
    const effectiveAlpha = nextAlpha === 0 && changedHex ? 100 : nextAlpha;
    if (changedHex || effectiveAlpha !== alpha) commitInPopover(joinColor(nextHex, effectiveAlpha));
  };
  // 弹层开着时写回了，写回的值就是新的打开基线：之后再预览、关弹层都跟它比，不还原到写回前的颜色（!3450 CR-01）
  function commitInPopover(next: string) {
    openedHexRef.current = splitColor(next).hex;
    openedValueRef.current = next;
    committedInPopoverRef.current = true;
    onCommit(next);
  }
  // 取色器预览过以后的收尾（关弹层、点色块共用）：预览已把 value 改成预览色，要跟打开弹层前的值比。
  // 改了色就按打开前的不透明度写回（透明原色按 100%）；回到原色就不写回，并把预览还原成打开前的值，页面和源码一致。
  // 取色器给大写 hex、源码可能是小写，按不分大小写比。
  const settlePreviewed = (finalHex: string) => {
    setPicked(null);
    const opened = splitColor(openedValueRef.current);
    if (finalHex.toLowerCase() !== openedHexRef.current.toLowerCase()) {
      commitInPopover(joinColor(finalHex, opened.alpha === 0 ? 100 : opened.alpha));
    } else if (committedInPopoverRef.current) {
      // 基线是弹层里写回过的值，那次写回可能失败、页面已撤回源码：再交一次写回，写成了源码不变（写回器跳过），
      // 没写成就照常撤回，页面与源码一致；不能只把预览改成基线
      onCommit(openedValueRef.current);
    } else {
      onPreview?.(openedValueRef.current);
    }
  };
  const commitHex = () => {
    if (hexCancelledRef.current) {
      hexCancelledRef.current = false;
      return;
    }
    if (draft === null) return;
    setDraft(null);
    const normalized = draft.trim().startsWith("#") ? draft.trim() : `#${draft.trim()}`;
    const color = parseCssColor(normalized);
    if (color) commitColor(toHexColor(color), alpha);
  };
  const commitAlpha = (next: number) => {
    setAlphaDraft(null);
    if (Number.isFinite(next)) commitColor(hex, Math.round(Math.max(0, Math.min(100, next))));
  };
  return (
    <div className={cn(FIELD_CLASS, disabled && "opacity-60")}>
      <Popover
        onOpenChange={(open) => {
          if (open) {
            openedHexRef.current = hex;
            openedValueRef.current = value;
            committedInPopoverRef.current = false;
            return;
          }
          if (picked === null) return;
          settlePreviewed(picked);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="grid h-full w-7 shrink-0 place-items-center disabled:cursor-not-allowed"
            disabled={disabled}
            title={label}
          >
            <span
              className="size-4 rounded-sm border border-border"
              style={{ background: alpha === 0 ? undefined : joinColor(hex, alpha) }}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-56 gap-2 p-2.5"
          // 页面里原地改字失焦时焦点从 webview 回到宿主；别把这次焦点变化当成点了外面
          onFocusOutside={(event) => event.preventDefault()}
        >
          <div className="text-ui-sm text-foreground-subtle">
            {t("browser.design.edit.pageColors")}
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {palette.map((color) => (
              <button
                key={color.name}
                type="button"
                aria-label={`${color.name} ${color.value}`}
                className={cn(
                  "size-6 rounded-md border border-border",
                  color.value.toLowerCase() === hex.toLowerCase() &&
                    "outline-2 outline-offset-2 outline-foreground",
                )}
                style={{ background: color.value }}
                title={`${color.name} ${color.value}`}
                onClick={() => {
                  // 取色器预览过以后，value 已是预览色：点色块要按打开前的值收尾（!3450 SG-01、CR-01）
                  if (picked !== null) settlePreviewed(color.value);
                  else commitColor(color.value, alpha);
                }}
              />
            ))}
          </div>
          <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            {t("browser.design.edit.customColor")}
            <input
              aria-label={t("browser.design.edit.customColor")}
              className="h-6 flex-1 cursor-pointer rounded-md border border-border bg-transparent"
              type="color"
              value={(picked ?? hex).toLowerCase()}
              onChange={(event) => {
                const next = event.target.value.toUpperCase();
                setPicked(next);
                onPreview?.(joinColor(next, alpha === 0 ? 100 : alpha));
              }}
            />
          </label>
        </PopoverContent>
      </Popover>
      <input
        {...dataAttribute}
        aria-label={label}
        data-design-draft={draft !== null}
        className="h-full w-full min-w-0 bg-transparent font-mono uppercase outline-none disabled:cursor-not-allowed"
        disabled={disabled}
        spellCheck={false}
        value={draft ?? hex.replace(/^#/u, "")}
        onBlur={commitHex}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitHex();
          if (event.key === "Escape") {
            hexCancelledRef.current = true;
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      <span className="h-4 w-px shrink-0 bg-border" />
      <input
        aria-label={t("browser.design.edit.opacity")}
        data-design-alpha={
          dataAttribute["data-design-field"] ?? dataAttribute["data-design-variable"]
        }
        data-design-draft={alphaDraft !== null}
        className="h-full w-9 shrink-0 bg-transparent pl-1.5 text-right tabular-nums outline-none disabled:cursor-not-allowed"
        disabled={disabled}
        inputMode="numeric"
        value={alphaDraft ?? String(alpha)}
        onBlur={() => {
          if (alphaCancelledRef.current) {
            alphaCancelledRef.current = false;
            return;
          }
          if (alphaDraft !== null) commitAlpha(Number.parseFloat(alphaDraft));
        }}
        onChange={(event) => setAlphaDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            commitAlpha(alpha + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1));
          } else if (event.key === "Enter" && alphaDraft !== null) {
            commitAlpha(Number.parseFloat(alphaDraft));
          } else if (event.key === "Escape") {
            alphaCancelledRef.current = true;
            setAlphaDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      <span className="shrink-0 pr-2 pl-0.5 text-foreground-subtle">%</span>
    </div>
  );
}

export function AlignButtons({
  disabled,
  onCommit,
  t,
  value,
}: {
  disabled?: boolean;
  onCommit: (value: string) => void;
  t: Translate;
  value: string;
}) {
  const items = [
    ["left", <AlignLeft key="l" className="size-3.5" />],
    ["center", <AlignCenter key="c" className="size-3.5" />],
    ["right", <AlignRight key="r" className="size-3.5" />],
  ] as const;
  return (
    <div className="grid h-7 grid-cols-3 rounded-md bg-input p-0.5">
      {items.map(([align, icon]) => (
        <Button
          key={align}
          type="button"
          size="icon-sm"
          variant="ghost"
          className={cn(
            "h-full w-full rounded-sm",
            value === align && "bg-background shadow-xs hover:bg-background",
          )}
          aria-label={t(`browser.design.edit.align.${align}`)}
          aria-pressed={value === align}
          data-design-align={align}
          disabled={disabled}
          title={t(`browser.design.edit.align.${align}`)}
          onClick={() => {
            if (value !== align) onCommit(align);
          }}
        >
          {icon}
        </Button>
      ))}
    </div>
  );
}
