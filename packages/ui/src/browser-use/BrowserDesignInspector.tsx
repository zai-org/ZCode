import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowUpToLine, Blend, Scan, Type, X } from "lucide-react";
import type { DesignTweakControl } from "@zcode/design-runtime";
import {
  TID_BROWSER_DESIGN_INSPECTOR,
  TID_BROWSER_DESIGN_INSPECTOR_CLOSE,
  TID_BROWSER_DESIGN_SELECT_PARENT,
  TID_BROWSER_DESIGN_SOURCE_STATUS,
} from "@zcode/shared/test-ids";
import {
  AlignButtons,
  ColorField,
  NumberField,
  type PaletteColor,
  type Translate,
} from "@/browser-use/BrowserDesignFields.js";
import { splitColor, type DesignStyleProperty } from "@/browser-use/browserDesignProperties.js";
import type { BrowserDesignModeController } from "@/browser-use/useBrowserDesignMode.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 画布右侧固定的属性面板（docs/browser-use/2026-11-03-browser-design-mode-spec.md 第五节）：
// 上半部分是选中元素的属性（多选时显示最后点的那个，改动作用于全部选中），下半部分是页面变量。
// 数值改动直接写回源文件；焦点在面板上（不在输入框里）时 Cmd/Ctrl + Z 撤销。纯展示，状态在 useBrowserDesignMode。

const TEXT_KINDS = new Set(["heading", "text", "link", "button"]);
const WEIGHTS = ["300", "400", "500", "600", "700", "800"] as const;

const px = (value: string) => Math.round(Number.parseFloat(value) || 0);

/** 页面 :root 里的颜色变量 + 黑白；色名用变量名去掉 -- */
function pagePalette(controls: readonly DesignTweakControl[]): PaletteColor[] {
  const colors = controls
    .filter((control) => control.type === "color")
    .map((control) => ({
      name: control.id.replace(/^--/u, ""),
      // 色块只给色相：半透明变量的透明度归它自己的字段，点色块沿用目标字段原来的不透明度
      value: splitColor(String(control.value)).hex.toUpperCase(),
    }));
  for (const [name, value] of [
    ["white", "#FFFFFF"],
    ["black", "#000000"],
  ] as const) {
    if (!colors.some((color) => color.value === value)) colors.push({ name, value });
  }
  return colors.slice(0, 12);
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border px-3 pt-3 pb-3.5 last:border-b-0 @max-[720px]/browser-canvas:px-2">
      <h3 className="text-ui-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** 只在写不回时说明原因；能写回是默认情况，不占面板（11-05 反馈） */
function SourceStatus({ design, t }: { design: BrowserDesignModeController; t: Translate }) {
  const message = !design.canWriteSource
    ? t("browser.design.source.pageUnavailable")
    : design.sourceUnreadable
      ? t("browser.design.source.unreadable")
      : design.writable === false
        ? t("browser.design.source.notMatched")
        : null;
  return (
    <p
      className={cn("px-3 text-ui-xs text-warning", message ? "py-2" : "hidden")}
      data-testid={TID_BROWSER_DESIGN_SOURCE_STATUS}
      data-writable={design.canWriteSource && design.writable === true}
    >
      {message}
    </p>
  );
}

/** 元素文字：回车或失焦提交，Esc 放弃；源码里只含文字的元素才出（写回只替换纯文字） */
function TextContentField({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit: (value: string) => void;
  value: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Esc 放弃输入：blur 同步触发 onBlur 时 draft 还没清掉，靠这个标记跳过提交（!3450 CR-03）
  const cancelledRef = useRef(false);
  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      aria-label={label}
      className="h-7 w-full min-w-0 rounded-md border border-input-border bg-input px-2 text-ui-sm outline-none hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused"
      data-design-draft={draft !== null}
      data-design-field="text"
      placeholder={label}
      value={draft ?? value}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) commit();
        if (event.key === "Escape") {
          cancelledRef.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** 文字类元素的「填充」是文字颜色（Figma 文字图层的 Fill）；其余元素是背景 */
const TEXT_FILL_KINDS = new Set(["heading", "text", "link"]);

function ElementProperties({
  design,
  palette,
  t,
}: {
  design: BrowserDesignModeController;
  palette: readonly PaletteColor[];
  t: Translate;
}) {
  const primary = design.selections.at(-1);
  if (!primary) return null;
  const values = primary.editable;
  const disabled = design.writable !== true;
  const preview = (property: DesignStyleProperty) => (value: string) =>
    design.previewStyle(property, value);
  const commit = (property: DesignStyleProperty) => (value: string) =>
    void design.commitStyle(property, value);
  const pxField = (property: DesignStyleProperty, value: number) => ({
    dataAttribute: { "data-design-field": property },
    disabled,
    value,
    onPreview: (next: number) => preview(property)(`${next}px`),
    onCommit: (next: number) => commit(property)(`${next}px`),
  });
  const padding = values.padding.split(/\s+/u).map(px);
  const setPadding = (index: number) => (next: number) => {
    const sides = [0, 1, 2, 3].map((side) => padding[side] ?? 0);
    sides[index] = next;
    return sides.map((side) => `${side}px`).join(" ");
  };
  const hasText = TEXT_KINDS.has(primary.kind) || values.text !== null;
  const fillProperty: DesignStyleProperty = TEXT_FILL_KINDS.has(primary.kind)
    ? "color"
    : "background";
  return (
    <>
      <Section title={t("browser.design.inspector.layout")}>
        <div className="grid grid-cols-2 gap-1.5">
          {(
            [
              ["W", "width", primary.size.width],
              ["H", "height", primary.size.height],
            ] as const
          ).map(([prefix, key, value]) => (
            <div
              key={key}
              className="flex h-7 items-center rounded-md bg-input text-ui-sm text-foreground-subtle"
              title={t(`browser.design.inspector.${key}`)}
            >
              <span className="w-6 text-center">{prefix}</span>
              <span className="tabular-nums" data-design-size={key}>
                {value}
              </span>
            </div>
          ))}
          {(
            [
              ["paddingTop", 0, "↑"],
              ["paddingRight", 1, "→"],
              ["paddingBottom", 2, "↓"],
              ["paddingLeft", 3, "←"],
            ] as const
          ).map(([key, index, prefix]) => (
            <NumberField
              key={key}
              dataAttribute={{ "data-design-field": key }}
              disabled={disabled}
              label={t(`browser.design.edit.${key}`)}
              prefix={prefix}
              value={padding[index] ?? 0}
              onCommit={(next) => commit("padding")(setPadding(index)(next))}
              onPreview={(next) => preview("padding")(setPadding(index)(next))}
            />
          ))}
        </div>
      </Section>
      <Section title={t("browser.design.edit.appearance")}>
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField
            dataAttribute={{ "data-design-field": "opacity" }}
            disabled={disabled}
            label={t("browser.design.edit.opacity")}
            max={100}
            prefix={<Blend className="size-3.5" />}
            suffix="%"
            value={Math.round((Number.parseFloat(values.opacity) || 0) * 100)}
            onCommit={(next) => commit("opacity")(String(next / 100))}
            onPreview={(next) => preview("opacity")(String(next / 100))}
          />
          <NumberField
            {...pxField("borderRadius", px(values.borderRadius))}
            label={t("browser.design.edit.borderRadius")}
            prefix={<Scan className="size-3.5" />}
          />
        </div>
      </Section>
      {hasText ? (
        <Section title={t("browser.design.edit.typography")}>
          {design.textWritable ? (
            <TextContentField
              key={primary.element.selector}
              label={t("browser.design.edit.content")}
              value={values.text ?? ""}
              onCommit={(text) => void design.commitText(text)}
            />
          ) : null}
          <div className="grid grid-cols-2 gap-1.5">
            <select
              aria-label={t("browser.design.edit.fontWeight")}
              className="h-7 min-w-0 rounded-md border border-input-border bg-input px-1.5 text-ui-sm hover:border-input-border-hover disabled:opacity-60"
              data-design-field="fontWeight"
              disabled={disabled}
              value={String(Math.round(Number(values.fontWeight) / 100) * 100)}
              onChange={(event) => commit("fontWeight")(event.target.value)}
            >
              {WEIGHTS.map((weight) => (
                <option key={weight} value={weight}>
                  {t(`browser.design.edit.weight.${weight}`)}
                </option>
              ))}
            </select>
            <NumberField
              {...pxField("fontSize", px(values.fontSize))}
              label={t("browser.design.edit.fontSize")}
              min={1}
              prefix={<Type className="size-3.5" />}
            />
          </div>
          <AlignButtons
            disabled={disabled}
            t={t}
            value={values.textAlign}
            onCommit={commit("textAlign")}
          />
          {fillProperty === "background" ? (
            <ColorField
              dataAttribute={{ "data-design-field": "color" }}
              disabled={disabled}
              label={t("browser.design.edit.color")}
              palette={palette}
              t={t}
              value={values.color}
              onCommit={commit("color")}
              onPreview={preview("color")}
            />
          ) : null}
        </Section>
      ) : null}
      <Section title={t("browser.design.edit.fill")}>
        <ColorField
          dataAttribute={{ "data-design-field": fillProperty }}
          disabled={disabled}
          label={t(
            fillProperty === "color"
              ? "browser.design.edit.color"
              : "browser.design.edit.background",
          )}
          palette={palette}
          t={t}
          value={values[fillProperty]}
          onCommit={commit(fillProperty)}
          onPreview={preview(fillProperty)}
        />
      </Section>
    </>
  );
}

function PageVariables({
  design,
  palette,
  t,
}: {
  design: BrowserDesignModeController;
  palette: readonly PaletteColor[];
  t: Translate;
}) {
  const disabled = !design.canWriteSource;
  return (
    <Section title={t("browser.design.variables")}>
      {design.tweakControls.length === 0 ? (
        <p className="text-ui-xs text-foreground-subtle">{t("browser.design.variables.empty")}</p>
      ) : (
        design.tweakControls.map((control) => {
          const preview = design.variablePreview[control.id];
          const name = control.id.replace(/^--/u, "");
          return (
            <div key={control.id} className="flex flex-col gap-1">
              <span
                className="truncate font-mono text-ui-xs text-foreground-subtle"
                title={control.id}
              >
                {name}
              </span>
              {control.type === "color" ? (
                <ColorField
                  dataAttribute={{ "data-design-variable": control.id }}
                  disabled={disabled}
                  label={name}
                  palette={palette}
                  t={t}
                  value={preview ?? String(control.value)}
                  onCommit={(value) => void design.commitVariable(control.id, value)}
                  onPreview={(value) => design.previewVariable(control.id, value)}
                />
              ) : (
                <NumberField
                  dataAttribute={{ "data-design-variable": control.id }}
                  disabled={disabled}
                  label={name}
                  min={Number.NEGATIVE_INFINITY}
                  step={control.step}
                  suffix={control.unit}
                  value={preview === undefined ? control.value : Number.parseFloat(preview)}
                  onCommit={(value) => void design.commitVariable(control.id, value)}
                  onPreview={(value) => design.previewVariable(control.id, value)}
                />
              )}
            </div>
          );
        })
      )}
    </Section>
  );
}

export function BrowserDesignInspector({ design }: { design: BrowserDesignModeController }) {
  const { intl } = useZCodeIntl();
  const t: Translate = (id, values) => intl.formatMessage({ id }, values);
  const palette = pagePalette(design.tweakControls);
  const { selections } = design;
  const primary = selections.at(-1);
  const title =
    selections.length > 1
      ? t("browser.design.inspector.selectedCount", { count: String(selections.length) })
      : primary
        ? t(`browser.design.edit.kind.${primary.kind}`)
        : t("browser.design.inspector.title");
  const titleHint = primary
    ? primary.element.accessibleName || primary.element.text || primary.element.tagName
    : title;
  // 字段里还有没提交的输入时，Cmd/Ctrl + Z 是撤销打字，交给浏览器；回车提交后焦点还在字段上，这时撤销的是写回
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z")
      return;
    if (target.dataset.designDraft === "true") return;
    event.preventDefault();
    void (event.shiftKey ? design.redo() : design.undo());
  };
  return (
    <aside
      aria-label={t("browser.design.inspector.title")}
      // 半屏等窄画布（< 720px）面板收窄到 192px，少挡画板（11-05 反馈）
      className="absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] w-64 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg @max-[720px]/browser-canvas:w-48"
      data-testid={TID_BROWSER_DESIGN_INSPECTOR}
      data-selected-count={selections.length}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3 @max-[720px]/browser-canvas:pl-2">
        <span className="min-w-0 flex-1 truncate text-ui-base font-semibold" title={titleHint}>
          {title}
        </span>
        {primary ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={t("browser.design.edit.parent")}
            data-testid={TID_BROWSER_DESIGN_SELECT_PARENT}
            title={t("browser.design.edit.parent")}
            onClick={design.selectParent}
          >
            <ArrowUpToLine className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t("browser.design.inspector.close")}
          data-testid={TID_BROWSER_DESIGN_INSPECTOR_CLOSE}
          title={t("browser.design.inspector.close")}
          onClick={() => design.setPanelOpen(false)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {primary ? (
          <>
            <SourceStatus design={design} t={t} />
            <ElementProperties design={design} palette={palette} t={t} />
          </>
        ) : (
          <p className="px-3 py-3 text-ui-sm text-foreground-subtle">
            {t("browser.design.inspector.empty")}
          </p>
        )}
        <PageVariables design={design} palette={palette} t={t} />
      </div>
    </aside>
  );
}
