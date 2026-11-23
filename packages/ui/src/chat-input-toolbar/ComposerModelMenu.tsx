import { useRef, useState, type ReactNode } from "react";
import { CircleXIcon, SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { isNoThoughtLevel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { ComposerEffortHeading } from "@/chat-input-toolbar/ComposerEffortHeading.js";
import { ComposerProviderMenu } from "@/chat-input-toolbar/ComposerProviderMenu.js";
import "@/chat-input-toolbar/composer-thought-slider.css";

// 固定种子避免重渲染重新随机，让最高档气泡错峰流动而不影响模型选择状态。
const EFFORT_BUBBLES = [
  { top: 4, size: 2, duration: 2.6, delay: -0.4 },
  { top: 14, size: 3, duration: 3.2, delay: -2.1 },
  { top: 8, size: 4, duration: 2.8, delay: -1.1 },
  { top: 18, size: 2, duration: 3.6, delay: -0.8 },
  { top: 3, size: 3, duration: 3, delay: -2.5 },
  { top: 12, size: 2, duration: 3.4, delay: -1.7 },
  { top: 6, size: 3, duration: 3.1, delay: -0.9 },
  { top: 17, size: 4, duration: 2.9, delay: -2.3 },
  { top: 10, size: 2, duration: 3.5, delay: -0.2 },
  { top: 2, size: 2, duration: 2.7, delay: -1.8 },
  { top: 15, size: 3, duration: 3.3, delay: -1.2 },
  { top: 7, size: 4, duration: 3.6, delay: -3.1 },
];

const HIGHSPEED_BUBBLES = Array.from({ length: 32 }, (_, index) => ({
  ...EFFORT_BUBBLES[index % EFFORT_BUBBLES.length]!,
  duration: (8 + (index % 5)) / 10,
  delay: -index * 0.137,
}));

export interface ComposerModelOptions {
  providerMenu?: {
    groups: readonly ComposerPlanGroup[];
    selectedKey?: string;
    pending: boolean;
    error: string | null;
    onSelect: (group: ComposerPlanGroup) => void;
  };
  providerLabel: string;
  modelsLabel: string;
  effortLabel: string;
  effortShortcutLabel?: string;
  selectModelLabel: string;
  levels: readonly { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
}

export function getComposerThoughtDisplay(options: ComposerModelOptions) {
  const current = options.levels.find((level) => level.value === options.value);
  const thinking = options.levels.filter((level) => !isNoThoughtLevel(level));
  const progress =
    current && !isNoThoughtLevel(current)
      ? ((thinking.findIndex((level) => level.value === current.value) + 1) / thinking.length) * 100
      : 0;
  return { label: current?.label ?? "—", progress };
}

export function isGlmHighspeedModel(name: string) {
  // GLM FlashX 与 Highspeed 共用视觉；只按显示名称判定，避免误命中其他品牌。
  return /glm/i.test(name) && /highspeed|flashx/i.test(name);
}

export function ComposerThoughtIndicator({
  options,
  highspeed = false,
}: {
  options: ComposerModelOptions;
  highspeed?: boolean;
}) {
  const { label, progress } = getComposerThoughtDisplay(options);
  return (
    <>
      <span
        className="shrink-0 text-foreground-subtle group-data-[composer-compact=true]/combined:hidden"
        data-composer-thought-label
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        data-testid="composer-thought-meter"
        data-highspeed={highspeed}
        data-progress={progress}
        className="relative hidden h-4 w-1 shrink-0 overflow-hidden rounded-full bg-foreground/10 group-data-[composer-compact=true]/combined:block"
      >
        <span
          className="composer-thought-meter-fill absolute bottom-0 left-0 w-full rounded-full bg-success"
          style={{ height: `${progress}%` }}
        />
      </span>
    </>
  );
}

export function ComposerModelMenu({
  groups,
  normalizedValue,
  options,
  renderItems,
  renderConnection,
  providerFooter,
  isItemLocked,
  onSelectModel,
}: {
  groups: readonly ModelSelectGroup[];
  normalizedValue: string;
  options: ComposerModelOptions;
  renderItems: (items: ModelSelectGroup["items"]) => ReactNode;
  renderConnection: (group: ModelSelectGroup) => ReactNode;
  providerFooter?: ReactNode;
  isItemLocked: (value: string) => boolean;
  onSelectModel: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 无可用模型的分组仍可浏览配置；实际选择始终由 Composer owner 回传。
  const [browse, setBrowse] = useState<{ key: string; selection: string } | null>(null);
  const menuGroups: readonly ComposerPlanGroup[] = options.providerMenu?.groups ?? groups;
  const selected =
    menuGroups.find((group) => group.key === options.providerMenu?.selectedKey) ??
    menuGroups.find((group) => group.items.some((item) => item.value === normalizedValue));
  const group =
    (browse?.selection === normalizedValue
      ? menuGroups.find((item) => item.key === browse.key)
      : undefined) ??
    selected ??
    menuGroups[0];
  const [search, setSearch] = useState({ groupKey: group?.key, query: "" });
  if (search.groupKey !== group?.key) setSearch({ groupKey: group?.key, query: "" });
  const query = search.groupKey === group?.key ? search.query : "";
  const filteredItems =
    group?.items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())) ??
    [];
  const modelListRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 视觉只由选中模型名称派生，避免供应商名或内部 value 含 highspeed 时误触发。
  const modelName = selected?.items.find((item) => item.value === normalizedValue)?.name ?? "";
  const highspeed = isGlmHighspeedModel(modelName);
  const currentGroupSelected = group?.key === selected?.key && Boolean(selected);
  const currentIndex = options.levels.findIndex((level) => level.value === options.value);
  const { label } = getComposerThoughtDisplay(options);
  const catalogPending = groups.length === 0 && Boolean(normalizedValue);
  const showEffort = options.levels.length > 0 || catalogPending;
  const [hoveredStop, setHoveredStop] = useState<string | null>(null);
  const sliderDisabled =
    Boolean(options.providerMenu?.pending) || !currentGroupSelected || options.levels.length < 2;
  const sliderProgress =
    options.levels.length > 1 && currentIndex >= 0 && currentGroupSelected
      ? (currentIndex / (options.levels.length - 1)) * 100
      : 0;
  const sliderFilled =
    currentGroupSelected && currentIndex >= 0 && !isNoThoughtLevel(options.levels[currentIndex]!);
  const selectSliderValue = (index: number) => {
    const level = options.levels[index];
    if (!sliderDisabled && level && level.value !== options.value)
      options.onValueChange(level.value);
  };
  return (
    <>
      <ComposerProviderMenu
        groups={menuGroups}
        error={options.providerMenu?.error}
        disabled={options.providerMenu?.pending}
        loading={options.providerMenu?.pending}
        isDisabled={(candidate) => Boolean((candidate as ComposerPlanGroup).connection?.disabled)}
        separatorBeforeKey={
          options.providerMenu
            ? menuGroups.find(
                (candidate) =>
                  !candidate.connection && !candidate.key.startsWith("registry-provider:account:"),
              )?.key
            : undefined
        }
        group={group}
        label={options.providerLabel}
        providerFooter={providerFooter}
        onSelect={(candidate) => {
          setSearch({ groupKey: candidate.key, query: "" });
          if (options.providerMenu) {
            options.providerMenu.onSelect(candidate as ComposerPlanGroup);
            return;
          }
          setBrowse({ key: candidate.key, selection: normalizedValue });
          // 复用唯一选择链路，供应商页只负责导航，不缓存模型状态。
          const model =
            candidate.items.find(
              (item) => item.value === normalizedValue && !isItemLocked(item.value),
            ) ?? candidate.items.find((item) => !isItemLocked(item.value));
          if (model && model.value !== normalizedValue) onSelectModel(model.value);
        }}
      >
        <div role="separator" className="-mx-1 my-1 h-px shrink-0 bg-border/50" />
        {/* 搜索栏重复的右内边距会比模型行多缩进 8px；右侧直接复用面板内边距。 */}
        <div className="flex items-center gap-2 pl-2 py-1">
          <span
            data-composer-model-heading
            className="shrink-0 py-1.5 text-ui-sm font-normal text-foreground-subtle"
          >
            {options.modelsLabel}
          </span>
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest"
            />
            <Input
              size="sm"
              ref={searchRef}
              // 原生 search 在聚焦且有文字时绘制蓝色清除按钮；用统一的主题控件承载清除操作。
              type="text"
              role="searchbox"
              value={query}
              data-testid="composer-model-search"
              aria-label={intl.formatMessage({ id: "chat.toolbar.model.searchPlaceholder" })}
              placeholder={intl.formatMessage({ id: "chat.toolbar.model.searchPlaceholder" })}
              className="rounded-full border-transparent bg-transparent pl-7 pr-7 text-ui-sm hover:border-border focus-visible:border-border focus-visible:bg-transparent compact-web:text-mobile-input-safe"
              onChange={(event) => setSearch({ groupKey: group?.key, query: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  modelListRef.current
                    ?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])')
                    ?.focus();
                }
              }}
            />
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="composer-model-search-clear"
                aria-label={intl.formatMessage({ id: "chat.toolbar.model.clearSearch" })}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full text-foreground-subtlest hover:bg-transparent hover:text-foreground-subtle focus-visible:border-border"
                onClick={() => {
                  setSearch({ groupKey: group?.key, query: "" });
                  searchRef.current?.focus();
                }}
              >
                <CircleXIcon aria-hidden="true" className="size-3.5 fill-current stroke-menu" />
              </Button>
            ) : null}
          </div>
        </div>
        {group ? renderConnection(group) : null}
        <ScrollFadeViewport
          ref={modelListRef}
          className="max-h-60 flex-initial"
          inert={options.providerMenu?.pending || undefined}
          data-composer-model-list
        >
          {filteredItems.length > 0 ? (
            renderItems(filteredItems)
          ) : (
            <div role="status" className="px-2 py-3 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolbar.model.empty" })}
            </div>
          )}
        </ScrollFadeViewport>
        {showEffort ? (
          <>
            <div role="separator" className="-mx-1 my-1 h-px shrink-0 bg-border/50" />
            {options.levels.length === 1 ? (
              // 单一档位没有可调范围；旧逻辑渲染禁用滑杆并提示快捷键，误导用户可调档。
              <div className="px-2 py-2">
                <ComposerEffortHeading
                  label={options.effortLabel}
                  value={currentGroupSelected ? label : "—"}
                />
              </div>
            ) : (
              <div className="px-2 py-2">
                <ComposerEffortHeading
                  label={options.effortLabel}
                  value={currentGroupSelected ? label : "—"}
                  shortcut={options.effortShortcutLabel}
                />
                <div
                  className="composer-thought-slider relative h-8 w-full rounded-full"
                  data-disabled={sliderDisabled}
                >
                  <div
                    // 模型或档位目录变化时只重置视觉层，避免跨模型补间，同时保留 input 焦点。
                    key={JSON.stringify([
                      normalizedValue,
                      group?.key,
                      options.levels.map((level) => level.value),
                    ])}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0"
                  >
                    <div
                      data-testid="composer-thought-track"
                      data-progress={sliderFilled ? sliderProgress : 0}
                      className="absolute inset-x-0 top-1 h-6 overflow-hidden rounded-full bg-foreground/10"
                    >
                      {/* 外层 border 会包住绿色填充；描边放到底层，让选中区域完全覆盖它。 */}
                      <div className="absolute inset-0 rounded-full border border-foreground/10" />
                      <div
                        className="composer-thought-slider-fill absolute inset-y-0 left-0 overflow-hidden rounded-full"
                        data-max={sliderFilled && currentIndex === options.levels.length - 1}
                        data-highspeed={highspeed && currentGroupSelected}
                        style={{
                          width: sliderFilled
                            ? `calc(14px + (100% - 28px) * ${sliderProgress / 100})`
                            : 0,
                        }}
                      >
                        {sliderFilled &&
                        currentIndex === options.levels.length - 1 &&
                        !sliderDisabled ? (
                          <div
                            data-testid="composer-thought-bubbles"
                            className="composer-thought-bubbles absolute inset-0"
                          >
                            {(highspeed ? HIGHSPEED_BUBBLES : EFFORT_BUBBLES).map(
                              (bubble, index) => (
                                <span
                                  key={index}
                                  className="composer-thought-bubble absolute inset-x-0"
                                  style={{
                                    top: bubble.top,
                                    animationDuration: `${bubble.duration}s`,
                                    animationDelay: `${bubble.delay}s`,
                                  }}
                                >
                                  <span
                                    className="block rounded-full bg-white"
                                    style={{ width: bubble.size, height: bubble.size }}
                                  />
                                </span>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="absolute inset-x-3.5 inset-y-0 flex items-center justify-between">
                      {options.levels.map((level, index) => (
                        <span
                          key={level.value}
                          data-composer-thought-stop
                          data-filled={sliderFilled && index <= currentIndex}
                          data-hovered={
                            !sliderDisabled && hoveredStop === `${normalizedValue}:${level.value}`
                          }
                          className="composer-thought-slider-stop size-1 shrink-0 rounded-full"
                        />
                      ))}
                    </div>
                    <div
                      className="composer-thought-slider-thumb absolute top-0.5 size-7 rounded-full shadow-sm"
                      style={{ left: `calc((100% - 28px) * ${sliderProgress / 100})` }}
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, options.levels.length - 1)}
                    step={1}
                    value={Math.max(0, currentIndex)}
                    // 目录在调档后会短暂重读；原生 disabled 会移走焦点，后续方向键落到菜单。
                    // 用 aria-disabled 保留焦点，等待期间通过事件与提交入口阻止交互。
                    aria-disabled={sliderDisabled}
                    aria-label={options.effortLabel}
                    aria-valuetext={currentGroupSelected ? label : "—"}
                    data-testid="composer-thought-slider"
                    data-levels={JSON.stringify(options.levels.map((level) => level.value))}
                    className="composer-thought-range absolute inset-0 m-0 h-8 w-full cursor-pointer appearance-none bg-transparent outline-none aria-disabled:cursor-default"
                    onPointerDown={(event) => {
                      // 拦截冒泡会让 Radix 的内部点击标记残留，导致第一次外部点击无法关闭菜单。
                      if (sliderDisabled) event.preventDefault();
                    }}
                    onPointerLeave={() => setHoveredStop(null)}
                    onPointerMove={(event) => {
                      // 原生 range 覆盖圆点，用坐标反馈悬停，避免圆点截获拖拽事件。
                      const rect = event.currentTarget.getBoundingClientRect();
                      const trackWidth = rect.width - 28;
                      const index = Math.round(
                        ((event.clientX - rect.left - 14) / trackWidth) *
                          (options.levels.length - 1),
                      );
                      const level = options.levels[index];
                      const center =
                        rect.left + 14 + (trackWidth * index) / (options.levels.length - 1);
                      setHoveredStop(
                        !sliderDisabled &&
                          event.pointerType !== "touch" &&
                          level &&
                          Math.abs(event.clientX - center) <= 10
                          ? `${normalizedValue}:${level.value}`
                          : null,
                      );
                    }}
                    onKeyDown={(event) => {
                      if (sliderDisabled && !["Tab", "Escape"].includes(event.key))
                        event.preventDefault();
                    }}
                    // 原因：缺失档位时 range 的物理位置仍为 0；Home 或点击首格不触发 change，
                    // 必须在明确完成手势时接纳首格选择，不能把展示位置提前当成用户意图。
                    onKeyUp={(event) => {
                      if (
                        [
                          "Home",
                          "End",
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                          "PageUp",
                          "PageDown",
                        ].includes(event.key)
                      )
                        selectSliderValue(Number(event.currentTarget.value));
                    }}
                    onPointerUp={(event) => {
                      selectSliderValue(Number(event.currentTarget.value));
                    }}
                    onChange={(event) => selectSliderValue(Number(event.currentTarget.value))}
                  />
                </div>
              </div>
            )}
          </>
        ) : null}
      </ComposerProviderMenu>
    </>
  );
}
