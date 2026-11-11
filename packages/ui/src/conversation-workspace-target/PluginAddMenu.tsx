import { ChevronDown, LoaderCircle, Plus, Sparkles } from "lucide-react";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePluginCreator } from "@/conversation-workspace-target/usePluginCreator.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PluginAddMenu({
  onCreateTask,
  onAddMarketplace,
  testId,
  variant = "default",
  size = "default",
  isWebRemoteControl = false,
}: {
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onAddMarketplace: () => void;
  testId: string;
  /** 市场顶栏与相邻动作统一 secondary + lg；设置页插件区保持默认主按钮。 */
  variant?: "default" | "secondary";
  size?: "default" | "lg";
  isWebRemoteControl?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const creator = usePluginCreator(onCreateTask, isWebRemoteControl);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant={variant} size={size} data-testid={testId}>
          {creator.busy ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          {intl.formatMessage({ id: "pluginCreator.add" })}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="plugin-add-menu">
        <DropdownMenuItem
          data-testid="plugin-create-menu-item"
          disabled={creator.busy || !creator.available}
          onSelect={() => void creator.create()}
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "pluginCreator.create" })}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="plugin-store-add-source-menu-item"
          onSelect={onAddMarketplace}
        >
          <Plus className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "pluginCreator.addMarketplace" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
