/* eslint-disable max-lines -- 设置页 provider 导航同时承载分组、卡片化预置入口和拖拽排序，当前先集中维护交互边界。 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LoaderCircle } from "lucide-react";
import { ProviderStatusIndicator } from "./ProviderStatusIndicator.js";

import {
  resolveModelProviderFamilySpecByProviderId,
  isStartPlanModelProviderId,
} from "@zcode/shared";
import { TID_MODEL_PROVIDER_NAV_ITEM, testId } from "@zcode/shared/test-ids";
import { useCallback, useMemo, type KeyboardEvent } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { ModelProviderNavGroup, ModelProviderNavItem } from "./constants.js";
import { useOptimisticReorder } from "./useOptimisticReorder.js";
import { renderModelProviderNavIcon } from "./utils.js";

// 侧栏会裁切水平溢出；排序只改变纵向位置，拖动时也必须保持 x=0。
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export function getSortableProviderId(
  item: ModelProviderNavItem,
  reorderableProviderIds?: ReadonlySet<string>,
): string | null {
  if ((item.type === "custom" || item.type === "preset") && item.provider) {
    return !reorderableProviderIds || reorderableProviderIds.has(item.provider.providerId)
      ? item.provider.providerId
      : null;
  }
  return null;
}

export function resolveReorderedProviderIdsForGroup(params: {
  activeProviderId: string;
  overProviderId: string;
  providerIds: readonly string[];
}): string[] {
  const activeIndex = params.providerIds.indexOf(params.activeProviderId);
  const overIndex = params.providerIds.indexOf(params.overProviderId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...params.providerIds];
  }
  return arrayMove([...params.providerIds], activeIndex, overIndex);
}

export function shouldShowModelProviderGroupLoadingIndicator(params: {
  groupId: ModelProviderNavGroup["id"];
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  if (params.groupId === "preset") {
    return params.presetLoading;
  }
  return params.customLoading;
}

export function resolveModelProviderSideNavLabel(item: ModelProviderNavItem): string {
  if (item.type === "preset") {
    return resolveModelProviderFamilySpecByProviderId(item.presetId)?.label ?? item.label;
  }
  if (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId)) {
    return "Start Plan";
  }
  return item.label;
}

function ModelProviderNavigationButton({
  item,
  label,
  selectedNodeKey,
  onSelectNavItem,
  showIcon = true,
}: {
  item: ModelProviderNavItem;
  label: string;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  showIcon?: boolean;
}) {
  const isSelected = item.key === selectedNodeKey;
  const isLoadingItem = item.type === "codingPlanLoading";
  const inactiveItemClassName = "border-transparent text-foreground hover:border-border-hover/60";

  return (
    <ControlHintTooltip title={label} side="right">
      <button
        type="button"
        disabled={isLoadingItem}
        aria-label={label}
        aria-selected={isSelected}
        data-state={isSelected ? "selected" : "idle"}
        data-testid={testId(TID_MODEL_PROVIDER_NAV_ITEM, item.key)}
        onClick={() => {
          if (isLoadingItem) {
            return;
          }
          onSelectNavItem(item);
        }}
        className={`relative box-border flex h-8 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors max-md:size-8 max-md:justify-center max-md:gap-0 max-md:px-0 ${
          isSelected
            ? "border-border-hover bg-card-selected text-foreground"
            : inactiveItemClassName
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {isLoadingItem ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin text-foreground-subtlest" />
        ) : showIcon ? (
          <span className="shrink-0 text-current">{renderModelProviderNavIcon(item)}</span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {"provider" in item ? (
          <ProviderStatusIndicator
            provider={item.type === "preset" ? item.statusProvider : item.provider}
          />
        ) : null}
      </button>
    </ControlHintTooltip>
  );
}

function handleModelProviderNavigationRowKeyDown({
  event,
  item,
  onSelectNavItem,
}: {
  event: KeyboardEvent<HTMLDivElement>;
  item: ModelProviderNavItem;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  onSelectNavItem(item);
}

function SortableModelProviderNavigationButton({
  providerId,
  item,
  label,
  selectedNodeKey,
  onSelectNavItem,
}: {
  providerId: string;
  item: ModelProviderNavItem;
  label: string;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: providerId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const isSelected = item.key === selectedNodeKey;
  const inactiveItemClassName = "border-transparent text-foreground hover:border-border-hover/60";
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    listeners?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    handleModelProviderNavigationRowKeyDown({ event, item, onSelectNavItem });
  };

  return (
    <ControlHintTooltip title={label} side="right">
      <div
        ref={setNodeRef}
        style={style}
        aria-label={label}
        aria-selected={isSelected}
        data-state={isSelected ? "selected" : "idle"}
        data-testid={testId(TID_MODEL_PROVIDER_NAV_ITEM, item.key)}
        onClick={() => onSelectNavItem(item)}
        {...attributes}
        {...listeners}
        onKeyDown={handleKeyDown}
        className={`relative box-border flex h-8 w-full cursor-grab touch-pan-y select-none items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-md:size-8 max-md:justify-center max-md:gap-0 max-md:px-0 ${
          isSelected
            ? "border-border-hover bg-card-selected text-foreground"
            : inactiveItemClassName
        } ${isDragging ? "z-20 opacity-70" : ""}`}
      >
        <span className="shrink-0 text-current" aria-hidden="true">
          {renderModelProviderNavIcon(item)}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {"provider" in item ? (
          <ProviderStatusIndicator
            provider={item.type === "preset" ? item.statusProvider : item.provider}
          />
        ) : null}
      </div>
    </ControlHintTooltip>
  );
}

function PresetProviderCardNavigation({
  group,
  selectedNodeKey,
  onSelectNavItem,
}: {
  group: ModelProviderNavGroup;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  return (
    <div className="flex flex-col gap-2 max-md:items-center max-md:gap-1">
      {group.items.map((item) => (
        <ModelProviderNavigationButton
          key={item.key}
          item={item}
          label={resolveModelProviderSideNavLabel(item)}
          selectedNodeKey={selectedNodeKey}
          onSelectNavItem={onSelectNavItem}
        />
      ))}
    </div>
  );
}

function SortableProviderNavigationGroup({
  group,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  sensors,
}: {
  group: ModelProviderNavGroup;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  sensors: ReturnType<typeof useSensors>;
}) {
  const authoritativeProviderIds = useMemo(
    () =>
      group.items.flatMap((item) => {
        const providerId = getSortableProviderId(item, reorderableProviderIds);
        return providerId ? [providerId] : [];
      }),
    [group.items, reorderableProviderIds],
  );
  const persist = useCallback(
    async (providerIds: readonly string[]) => {
      await onReorderProviderIds?.([...providerIds]);
    },
    [onReorderProviderIds],
  );
  const optimisticOrder = useOptimisticReorder({
    authoritativeIds: authoritativeProviderIds,
    persist,
  });
  const renderedItems = useMemo(
    () =>
      projectItemsToOptimisticProviderOrder({
        items: group.items,
        providerIds: optimisticOrder.renderedIds,
        reorderableProviderIds,
      }),
    [group.items, optimisticOrder.renderedIds, reorderableProviderIds],
  );

  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToVerticalAxis]}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        const activeProviderId = String(event.active.id);
        const overProviderId = event.over ? String(event.over.id) : "";
        if (!overProviderId || activeProviderId === overProviderId) return;
        const nextProviderIds = resolveReorderedProviderIdsForGroup({
          activeProviderId,
          overProviderId,
          providerIds: optimisticOrder.renderedIds,
        });
        void optimisticOrder.commit(nextProviderIds).catch(() => undefined);
      }}
    >
      <SortableContext
        items={[...optimisticOrder.renderedIds]}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-1 max-md:items-center">
          {renderedItems.map((item) => {
            const providerId = getSortableProviderId(item, reorderableProviderIds);
            if (!providerId) {
              return (
                <ModelProviderNavigationButton
                  key={item.key}
                  item={item}
                  label={item.label}
                  selectedNodeKey={selectedNodeKey}
                  onSelectNavItem={onSelectNavItem}
                />
              );
            }
            return (
              <SortableModelProviderNavigationButton
                key={item.key}
                providerId={providerId}
                item={item}
                label={item.label}
                selectedNodeKey={selectedNodeKey}
                onSelectNavItem={onSelectNavItem}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function projectItemsToOptimisticProviderOrder({
  items,
  providerIds,
  reorderableProviderIds,
}: {
  items: readonly ModelProviderNavItem[];
  providerIds: readonly string[];
  reorderableProviderIds?: ReadonlySet<string>;
}): ModelProviderNavItem[] {
  const itemByProviderId = new Map(
    items.flatMap((item) => {
      const providerId = getSortableProviderId(item, reorderableProviderIds);
      return providerId ? ([[providerId, item]] as const) : [];
    }),
  );
  let providerIndex = 0;
  return items.map((item) => {
    if (!getSortableProviderId(item, reorderableProviderIds)) return item;
    const providerId = providerIds[providerIndex++];
    return (providerId && itemByProviderId.get(providerId)) || item;
  });
}

export function ModelProviderSectionNavigation({
  navigationGroups,
  selectedNodeKey,
  presetLoading,
  customLoading,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
}: {
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  presetLoading: boolean;
  customLoading: boolean;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  return (
    <aside className="px-1.5 py-3 md:py-2 md:px-2">
      <div className="flex min-h-0 flex-col gap-3 max-md:gap-1">
        {navigationGroups
          .filter((group) => group.id !== "custom" || group.items.length > 0)
          .map((group) => (
            <div key={group.id} className="flex flex-col gap-2 max-md:gap-1">
              <div className="flex h-7 items-center justify-between px-2 py-1 max-md:hidden">
                <h3 className="text-ui-sm font-semibold text-foreground-subtlest">{group.title}</h3>
                {shouldShowModelProviderGroupLoadingIndicator({
                  groupId: group.id,
                  presetLoading,
                  customLoading,
                }) ? (
                  <LoaderCircle className="size-3 animate-spin text-foreground-subtlest" />
                ) : null}
              </div>

              {group.id === "preset" ? (
                <PresetProviderCardNavigation
                  group={group}
                  selectedNodeKey={selectedNodeKey}
                  onSelectNavItem={onSelectNavItem}
                />
              ) : (
                <SortableProviderNavigationGroup
                  group={group}
                  selectedNodeKey={selectedNodeKey}
                  onSelectNavItem={onSelectNavItem}
                  onReorderProviderIds={onReorderProviderIds}
                  reorderableProviderIds={reorderableProviderIds}
                  sensors={sensors}
                />
              )}
            </div>
          ))}
      </div>
    </aside>
  );
}
