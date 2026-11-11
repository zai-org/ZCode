import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, PanelRight } from "lucide-react";
import {
  TID_BROWSER_DESIGN_PANEL_BUTTON,
  TID_BROWSER_DESIGN_SLIDE_COUNTER,
  TID_BROWSER_DESIGN_SLIDE_NEXT,
  TID_BROWSER_DESIGN_SLIDE_PREV,
  TID_BROWSER_DESIGN_TOOLBAR,
  TID_BROWSER_DESIGN_VARIANT_OPTION,
  TID_BROWSER_DESIGN_VARIANT_SELECT,
} from "@zcode/shared/test-ids";
import type { BrowserDesignModeController } from "@/browser-use/useBrowserDesignMode.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 设计工具行（docs/browser-use/2026-11-03-browser-design-mode-spec.md）：属性面板开关、版本、翻页、设备预设。
// 纯展示：状态和动作都来自 useBrowserDesignMode。

const ALL_VARIANTS_VALUE = "__zcode-all-variants__";

function ToolButton({
  active,
  children,
  icon,
  onClick,
  testId,
}: {
  active: boolean;
  children: string;
  icon: ReactNode;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      aria-label={children}
      aria-pressed={active}
      title={children}
      className="shrink-0"
      data-testid={testId}
      onClick={onClick}
    >
      {icon}
      {/* 侧栏窄时只留图标，避免设计工具栏横向滚动 */}
      <span className="@max-xl/design-toolbar:hidden">{children}</span>
    </Button>
  );
}

export function BrowserDesignToolbar({
  design,
  viewportControls,
}: {
  design: BrowserDesignModeController;
  /** 自由尺寸打开时的设备预设控件：放进同一行中间，不再单独占一行 */
  viewportControls?: ReactNode;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const info = design.pageInfo;
  const { slide } = design;
  return (
    <div
      aria-label={intl.formatMessage({ id: "browser.design.toolbar" })}
      // 放不下时折成两行（设备预设落到第二行），不出现横向滚动
      className="@container/design-toolbar flex min-h-8 shrink-0 flex-wrap items-center gap-x-1 border-y border-border bg-background px-2"
      data-testid={TID_BROWSER_DESIGN_TOOLBAR}
      role="toolbar"
    >
      {/* 面板开关只在点选（设计模式）里出现；退出点选就是退出设计模式（11-05 反馈） */}
      {design.mode !== "off" ? (
        <ToolButton
          active={design.panelOpen}
          icon={<PanelRight className="size-4" />}
          testId={TID_BROWSER_DESIGN_PANEL_BUTTON}
          onClick={() => design.setPanelOpen(!design.panelOpen)}
        >
          {intl.formatMessage({ id: "browser.design.panel" })}
        </ToolButton>
      ) : null}
      {info && info.variants.length > 0 ? (
        <Select
          value={design.variant ?? ALL_VARIANTS_VALUE}
          onValueChange={(value) => design.setVariant(value === ALL_VARIANTS_VALUE ? null : value)}
        >
          <SelectTrigger
            aria-label={intl.formatMessage({ id: "browser.design.variant" })}
            className="min-w-24 shrink-0 font-medium"
            data-testid={TID_BROWSER_DESIGN_VARIANT_SELECT}
            size="default"
            variant="ghost"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem
              data-testid={`${TID_BROWSER_DESIGN_VARIANT_OPTION}-all`}
              value={ALL_VARIANTS_VALUE}
            >
              {intl.formatMessage({ id: "browser.design.variant.all" })}
            </SelectItem>
            {info.variants.map((name) => (
              <SelectItem
                data-testid={`${TID_BROWSER_DESIGN_VARIANT_OPTION}-${name}`}
                key={name}
                value={name}
              >
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {slide.count > 0 ? (
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "browser.design.slidePrev" })}
            data-testid={TID_BROWSER_DESIGN_SLIDE_PREV}
            disabled={slide.index <= 0}
            onClick={() => design.goToSlide(slide.index - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span
            className="min-w-12 text-center text-ui-base font-medium tabular-nums"
            data-testid={TID_BROWSER_DESIGN_SLIDE_COUNTER}
          >
            {slide.index + 1} / {slide.count}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "browser.design.slideNext" })}
            data-testid={TID_BROWSER_DESIGN_SLIDE_NEXT}
            disabled={slide.index >= slide.count - 1}
            onClick={() => design.goToSlide(slide.index + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}
      {/* 按尺寸控件的内容宽度参与换行；flex-1 的零基准会让容器被压窄，子控件溢出。 */}
      <div className="flex min-w-0 flex-auto justify-center">{viewportControls}</div>
    </div>
  );
}
