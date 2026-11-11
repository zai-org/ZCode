import {
  MousePointer2Icon,
  PencilIcon,
  TypeIcon,
  SquareIcon,
  CircleIcon,
  ArrowUpRightIcon,
  Undo2Icon,
  Redo2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AnnotationTool } from "@/image-preview-editor/geometry.js";
const TOOLS = [
  ["select", MousePointer2Icon],
  ["pen", PencilIcon],
  ["text", TypeIcon],
  ["rectangle", SquareIcon],
  ["ellipse", CircleIcon],
  ["arrow", ArrowUpRightIcon],
] as const;
export function ImageEditorToolbar({
  tool,
  onTool,
  color,
  onColor,
  undo,
  redo,
  canUndo,
  canRedo,
  disabled,
}: {
  tool: AnnotationTool;
  onTool: (value: AnnotationTool) => void;
  color: string;
  onColor: (value: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      role="toolbar"
      aria-label={intl.formatMessage({ id: "imageEditor.tools" })}
      className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain border-t border-border pt-1"
    >
      <div className="flex flex-col gap-0.5">
        {TOOLS.map(([value, Icon]) => (
          <Button
            key={value}
            data-image-preview-tool={value}
            title={intl.formatMessage({ id: `imageEditor.${value}` })}
            aria-label={intl.formatMessage({ id: `imageEditor.${value}` })}
            aria-pressed={tool === value}
            disabled={disabled}
            onClick={() => onTool(value)}
            className={
              tool === value
                ? "bg-accent text-foreground ring-1 ring-inset ring-border"
                : "text-foreground-subtle"
            }
            variant="ghost"
            size="icon-lg"
          >
            <Icon />
          </Button>
        ))}
      </div>
      <div className="flex w-full justify-center border-y border-border py-2">
        <label className="relative flex size-8 cursor-pointer items-center justify-center rounded-lg focus-within:ring-2 focus-within:ring-brand">
          <span
            className="size-5 rounded-full border-2 border-popover ring-1 ring-border"
            style={{ backgroundColor: color }}
          />
          <input
            type="color"
            aria-label={intl.formatMessage({ id: "imageEditor.color" })}
            title={intl.formatMessage({ id: "imageEditor.color" })}
            value={color}
            onChange={(event) => onColor(event.target.value)}
            disabled={disabled}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
      </div>
      <div className="flex flex-col gap-0.5">
        <Button
          title={intl.formatMessage({ id: "imageEditor.undo" })}
          aria-label={intl.formatMessage({ id: "imageEditor.undo" })}
          disabled={disabled || !canUndo}
          onClick={undo}
          variant="ghost"
          size="icon-lg"
        >
          <Undo2Icon />
        </Button>
        <Button
          title={intl.formatMessage({ id: "imageEditor.redo" })}
          aria-label={intl.formatMessage({ id: "imageEditor.redo" })}
          disabled={disabled || !canRedo}
          onClick={redo}
          variant="ghost"
          size="icon-lg"
        >
          <Redo2Icon />
        </Button>
      </div>
    </div>
  );
}
