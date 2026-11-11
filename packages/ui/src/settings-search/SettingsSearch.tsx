import { Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import type { SettingsSearchResult } from "@/settings-search/contract.js";
import {
  isSettingsSectionAvailable,
  type createSettingsPageConfig,
} from "@/settings/settingsPageConfig.js";
import {
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchAvailability,
} from "@/settings-search/settingsSearchIndex.js";
import {
  matchesSettingsNavigation,
  settingsNavigationSearchKeys,
} from "@/settings-search/settingsNavigationSearch.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { resolveDynamicWorkflowModeSettingView } from "@/settings/DynamicWorkflowModeSetting.js";

export function SettingsSearch({
  sections,
  availability,
  onSelect,
}: {
  sections: ReturnType<typeof createSettingsPageConfig>["settingsSections"];
  availability: Omit<SettingsSearchAvailability, "workflow">;
  onSelect: (result: SettingsSearchResult) => void;
}) {
  const { intl } = useZCodeIntl();
  const visible: SettingsSearchAvailability = {
    ...availability,
    workflow: resolveDynamicWorkflowModeSettingView(useDynamicWorkflowAvailability()) !== null,
  };
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedRef = useRef<SettingsSearchResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const title = intl.formatMessage({ id: "settings.search.title" });
  const entries = useMemo(
    () =>
      sections.flatMap((section) => {
        const sectionLabel = intl.formatMessage({ id: section.titleId });
        const items = SETTINGS_SEARCH_ITEMS.filter((item) => item.section === section.id).map(
          (item) => ({
            section: section.id,
            setting: item.id,
            label: intl.formatMessage({ id: item.id }),
            sectionLabel,
            keys: settingsNavigationSearchKeys([
              intl.formatMessage({ id: item.id }),
              enUS[item.id] ?? "",
            ]),
            descriptionKeys: [
              intl.formatMessage({ id: item.description }),
              enUS[item.description] ?? "",
            ],
            visibility: item.visibility,
          }),
        );
        return [
          {
            section: section.id,
            setting: undefined,
            label: sectionLabel,
            sectionLabel,
            keys: settingsNavigationSearchKeys([sectionLabel, enUS[section.titleId] ?? ""]),
            descriptionKeys: [],
            visibility: "all" as const,
          },
          ...items,
        ];
      }),
    [sections, intl],
  );
  const results = entries
    .flatMap((entry) => {
      if (
        !isSettingsSectionAvailable(entry.section, availability.desktop) ||
        (entry.visibility !== "all" && !visible[entry.visibility])
      )
        return [];
      const nameMatch = matchesSettingsNavigation(query, entry.keys);
      // 说明较长，只做片段匹配，避免顺序字符在整段说明中产生大量无关结果。
      const descriptionMatch =
        query.trim() &&
        entry.descriptionKeys.some((text) =>
          text
            .normalize("NFKC")
            .toLowerCase()
            .includes(query.normalize("NFKC").trim().toLowerCase()),
        );
      return nameMatch || descriptionMatch ? [{ ...entry, rank: nameMatch ? 0 : 1 }] : [];
    })
    .sort((left, right) => left.rank - right.rank);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          selectedRef.current = null;
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={title}
          data-testid="settings-search-open"
          className="w-full justify-start gap-2 text-foreground-subtle max-lg:size-9 max-lg:justify-center max-lg:px-0"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate max-lg:sr-only">{title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        data-testid="settings-search-dialog"
        showCloseButton={false}
        className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          const selected = selectedRef.current;
          if (selected) {
            // 先结束 Dialog 的焦点锁，再导航，让目标设置行拥有最后一次聚焦权。
            if (selected.setting) event.preventDefault();
            selectedRef.current = null;
            onSelect(selected);
          }
        }}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) {
            event.preventDefault();
            return;
          }
          if (query) {
            event.preventDefault();
            setQuery("");
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.search.description" })}
          </DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} label={title} className="rounded-xl p-2">
          <div className="relative">
            <CommandInput
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              aria-label={title}
              placeholder={title}
              data-testid="settings-search-input"
              className="pr-9 compact-web:text-mobile-input-safe"
            />
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "settings.search.clear" })}
                data-testid="settings-search-clear"
                className="absolute right-2 top-1.5"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
          <CommandList
            className="max-h-[55vh]"
            aria-label={intl.formatMessage({ id: "settings.search.results" })}
          >
            {results.length === 0 ? (
              <p
                role="status"
                data-testid="settings-search-empty"
                className="px-4 py-8 text-center text-ui-base text-foreground-subtle"
              >
                {intl.formatMessage({ id: "settings.search.empty" })}
              </p>
            ) : (
              results.map((entry) => (
                <CommandItem
                  key={entry.setting ?? entry.section}
                  value={entry.setting ?? entry.section}
                  data-settings-search-result={entry.setting ?? entry.section}
                  className="items-start rounded-md py-2"
                  onSelect={() => {
                    selectedRef.current = entry;
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-ui-base">{entry.label}</span>
                    <span className="block text-ui-sm text-foreground-subtle">
                      {entry.setting
                        ? entry.sectionLabel
                        : intl.formatMessage({ id: "settings.search.section" })}
                    </span>
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
