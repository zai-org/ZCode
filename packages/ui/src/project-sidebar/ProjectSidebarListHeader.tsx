import { memo, type Ref } from "react";
import { Bell, Clock, Folder, Hash, ListFilter, Search } from "lucide-react";
import type { ProjectSidebarProps, ProjectSidebarView } from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCommandShortcutLabel } from "@/lib/keyboardShortcuts.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

/** 列表头部独立于导航和滚动内容，搜索与视图仍使用现有 owner。 */
// 项目展开不改变搜索或视图；memo 只隔离父更新，真实视图与语言变化仍正常传播。
export const ProjectSidebarListHeader = memo(function ProjectSidebarListHeader({
  onOpenCommandCenter,
  view,
  onViewChange,
  groupedActionsRef,
}: {
  onOpenCommandCenter: ProjectSidebarProps["onOpenCommandCenter"];
  view: ProjectSidebarView;
  onViewChange(view: ProjectSidebarView): void;
  groupedActionsRef?: Ref<HTMLDivElement>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1 px-2 pb-2"
      data-testid="sidebar-search-toolbar"
    >
      <span
        data-testid="sidebar-list-title"
        className="min-w-0 flex-1 truncate px-2.5 text-ui-base font-medium text-foreground-subtle"
      >
        {intl.formatMessage({ id: "taskList.title" })}
      </span>
      <div
        ref={groupedActionsRef}
        className={view === "grouped" ? "flex items-center gap-1" : "hidden"}
      />
      <ControlHintTooltip
        // 原因：快捷键拼入标题会继承标题样式；用独立 shortcut 复用标准键帽。
        title={intl.formatMessage({ id: "commandCenter.open" })}
        shortcut={formatCommandShortcutLabel("k")}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-foreground-subtle hover:text-foreground"
          data-testid="sidebar-search-open"
          aria-label={intl.formatMessage({ id: "commandCenter.open" })}
          onClick={onOpenCommandCenter}
        >
          <Search className="size-3.5" />
        </Button>
      </ControlHintTooltip>
      <DropdownMenu>
        <ControlHintTooltip title={intl.formatMessage({ id: "project.view" })}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              data-testid="sidebar-view-menu"
              aria-label={intl.formatMessage({ id: "project.view" })}
            >
              <ListFilter className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={view}
            onValueChange={(value) => {
              if (
                value === "projects" ||
                value === "grouped" ||
                value === "timeline" ||
                value === "unread"
              )
                onViewChange(value);
            }}
          >
            <DropdownMenuRadioItem data-testid="sidebar-view-projects" value="projects">
              <Folder className="size-4 text-foreground-subtle" aria-hidden="true" />
              {intl.formatMessage({ id: "project.viewByProject" })}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem data-testid="sidebar-view-grouped" value="grouped">
              <Hash className="size-4 text-foreground-subtle" aria-hidden="true" />
              {intl.formatMessage({ id: "taskGroup.view" })}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem data-testid="sidebar-view-timeline" value="timeline">
              <Clock className="size-4 text-foreground-subtle" aria-hidden="true" />
              {intl.formatMessage({ id: "project.viewRecentlyUpdated" })}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem data-testid="sidebar-view-unread" value="unread">
              <Bell className="size-4 text-foreground-subtle" aria-hidden="true" />
              {intl.formatMessage({ id: "project.viewUnread" })}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
