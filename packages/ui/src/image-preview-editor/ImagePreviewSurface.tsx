import {
  useEffect,
  useLayoutEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { MinusIcon, PlusIcon, PencilIcon, ChevronRightIcon, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { ImagePreviewSurfaceProps } from "@/image-preview-editor/contract.js";
import { captureImageComposerTarget } from "@/image-preview-editor/composerTarget.js";
import { AnnotationLayer, exportAnnotatedImage } from "@/image-preview-editor/annotations.js";
import { ImagePreviewActions } from "@/image-preview-editor/ImagePreviewActions.js";
import { ImageEditorToolbar } from "@/image-preview-editor/ImageEditorToolbar.js";
import {
  clampOffset,
  zoomAtPoint,
  updateHistory,
  undoHistory,
  redoHistory,
  type Point,
  type Annotation,
  type AnnotationTool,
  type History,
  type Transform,
} from "@/image-preview-editor/geometry.js";

type Gesture = { start: Point; transform: Transform; annotation?: Annotation; moving?: boolean };
const ZERO = { x: 0, y: 0 };
export function ImagePreviewSurface({
  src,
  alt,
  filename,
  imageTestId,
  onDownload,
  downloading,
  onSaved,
  onClose,
  onNavigationGuardChange,
}: ImagePreviewSurfaceProps) {
  const { intl } = useZCodeIntl();
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const actionPending = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingExit, setPendingExit] = useState<(() => void) | null>(null);
  const [editing, setEditing] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null),
    surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null),
    overlayRef = useRef<SVGSVGElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [addPosition, setAddPosition] = useState<{ left: number; top: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<Transform>({ scale: 1, offset: ZERO });
  const [tool, setTool] = useState<AnnotationTool>("select"),
    [color, setColor] = useState("#ef4444");
  const [history, setHistory] = useState<History<Annotation>>({
    past: [],
    present: [],
    future: [],
  });
  const [draft, setDraft] = useState<Annotation | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<Annotation | null>(null),
    [saving, setSaving] = useState(false),
    [dragging, setDragging] = useState(false);
  const gestureRef = useRef<Gesture | null>(null),
    draftRef = useRef<Annotation | null>(null);
  const pointers = useRef(new Map<number, Point>()),
    pinch = useRef<{ distance: number; transform: Transform } | null>(null);
  const savePending = useRef(false),
    alive = useRef(true);
  const fit = Math.min(
    1,
    viewport.width / (natural.width || 1),
    viewport.height / (natural.height || 1),
  );
  const size = { width: natural.width * fit, height: natural.height * fit };
  const canPan =
    size.width * transform.scale > viewport.width + 1 ||
    size.height * transform.scale > viewport.height + 1;
  const cursor =
    tool === "select"
      ? canPan
        ? dragging
          ? "grabbing"
          : "grab"
        : "default"
      : tool === "text"
        ? "text"
        : "crosshair";
  const displayed = history.present.map((a) => (draft?.id === a.id ? draft : a));
  if (draft && !history.present.some((a) => a.id === draft.id)) displayed.push(draft);
  if (textDraft?.text?.trim()) displayed.push(textDraft);
  const commit = (annotations: Annotation[]) => setHistory((h) => updateHistory(h, annotations));
  const setCurrentDraft = (value: Annotation | null) => {
    draftRef.current = value;
    setDraft(value);
  };
  const undo = () => {
    setHistory(undoHistory);
    setSelected(null);
    setTextDraft(null);
  };
  const redo = () => {
    setHistory(redoHistory);
    setSelected(null);
    setTextDraft(null);
  };
  const applyTransform = (value: Transform) =>
    setTransform({ ...value, offset: clampOffset(value.offset, value.scale, size, viewport) });
  const zoom = (scale: number, anchor: Point = ZERO) =>
    applyTransform(zoomAtPoint(transform, Math.min(3, Math.max(0.5, scale)), anchor));
  const point = (client: Point): Point => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(natural.width, ((client.x - rect.left) / rect.width) * natural.width),
      ),
      y: Math.max(
        0,
        Math.min(natural.height, ((client.y - rect.top) / rect.height) * natural.height),
      ),
    };
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() =>
      setViewport({ width: viewport.clientWidth, height: viewport.clientHeight }),
    );
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setTransform((current) => ({
      ...current,
      offset: clampOffset(current.offset, current.scale, size, viewport),
    }));
  }, [size.width, size.height, viewport.width, viewport.height]);
  const wheel = useEffectEvent((event: WheelEvent) => {
    if (saving || actionBusy || pendingExit || gestureRef.current || !natural.width) return;
    event.preventDefault();
    const rect = viewportRef.current!.getBoundingClientRect();
    const delta =
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    zoom(transform.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    });
  });
  useEffect(() => {
    const viewport = viewportRef.current;
    // React 的委托 wheel 默认 passive，无法阻止页面滚动；监听仅归当前图片视口所有。
    const listener = (event: WheelEvent) => wheel(event);
    viewport?.addEventListener("wheel", listener, { passive: false });
    return () => viewport?.removeEventListener("wheel", listener);
  }, []);
  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (
      !editing ||
      saving ||
      actionBusy ||
      pendingExit ||
      (event.target instanceof Element &&
        event.target.closest("input,textarea,[contenteditable=true]"))
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (selected && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      commit(history.present.filter((a) => a.id !== selected));
      setSelected(null);
    }
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyboard(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (saving || actionBusy || pendingExit || event.button !== 0 || !natural.width) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const client = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, client);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(b!.x - a!.x, b!.y - a!.y), transform };
      setCurrentDraft(null);
      gestureRef.current = null;
      return;
    }
    const start = point(client);
    const id = (event.target as Element)
      .closest("[data-annotation-id]")
      ?.getAttribute("data-annotation-id");
    // 收起标注后只允许预览拖动，不再命中历史标注；隐藏工具栏不能留下隐形编辑入口。
    const annotation = editing ? history.present.find((a) => a.id === id) : undefined;
    if (tool === "text") {
      if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
      setTextDraft({
        id: crypto.randomUUID(),
        tool: "text",
        color,
        width: Math.max(2, 4 / fit),
        points: [start],
        text: "",
      });
      return;
    }
    if (tool === "select") {
      setSelected(annotation?.id ?? null);
      setDragging(Boolean(annotation || canPan));
      gestureRef.current = {
        start: annotation ? start : client,
        transform,
        annotation,
        moving: Boolean(annotation),
      };
      return;
    }
    const mark: Annotation = {
      id: crypto.randomUUID(),
      tool,
      color,
      width: Math.max(2, 3 / fit),
      points: [start],
    };
    gestureRef.current = { start, transform, annotation: mark };
    setCurrentDraft(mark);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const client = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, client);
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const scale = Math.min(
        3,
        Math.max(
          0.5,
          (pinch.current.transform.scale * Math.hypot(b!.x - a!.x, b!.y - a!.y)) /
            (pinch.current.distance || 1),
        ),
      );
      applyTransform({ ...pinch.current.transform, scale });
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!gesture.annotation) {
      if (canPan)
        applyTransform({
          ...transform,
          offset: {
            x: gesture.transform.offset.x + client.x - gesture.start.x,
            y: gesture.transform.offset.y + client.y - gesture.start.y,
          },
        });
      return;
    }
    const current = point(client),
      mark = gesture.annotation;
    if (gesture.moving) {
      setCurrentDraft({
        ...mark,
        points: mark.points.map((p) => ({
          x: p.x + current.x - gesture.start.x,
          y: p.y + current.y - gesture.start.y,
        })),
      });
      return;
    }
    setCurrentDraft({
      ...mark,
      points:
        mark.tool === "pen"
          ? [...(draftRef.current?.points ?? mark.points), current]
          : [gesture.start, current],
    });
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const mark = draftRef.current;
    // 原生取色器关闭后，松手可能先发 lostpointercapture 再发 pointerup；
    // buttons=0 表示已松手，仍需提交笔画，否则完整笔画会被误当取消而丢失。
    // 真正的 cancel / 按住时失去捕获仍丢弃草稿，后续重复结束事件由 pointer 集合过滤。
    const completed =
      event.type === "pointerup" || (event.type === "lostpointercapture" && event.buttons === 0);
    if (completed && mark)
      commit(
        gestureRef.current?.moving
          ? history.present.map((a) => (a.id === mark.id ? mark : a))
          : [...history.present, mark],
      );
    setCurrentDraft(null);
    gestureRef.current = null;
    pinch.current = null;
    setDragging(false);
  };
  const dirty = displayed.length > 0;
  const activeDrawingId = textDraft?.text?.trim()
    ? textDraft.id
    : (draft?.id ?? displayed.find((item) => item.id === selected)?.id ?? displayed.at(-1)?.id);
  useLayoutEffect(() => {
    const viewportElement = viewportRef.current;
    const button = addButtonRef.current;
    const group = Array.from(overlayRef.current?.children ?? []).find(
      (element) => element.getAttribute("data-annotation-id") === activeDrawingId,
    );
    if (!viewportElement || !button || !group?.firstElementChild) return;
    // 按实际 SVG 图形包围盒定位，不能把整张图片底边当作用户刚画的圆圈底边。
    // 屏幕坐标已包含缩放和平移，文字/箭头也沿用真实渲染尺寸，不另猜路径范围。
    const drawing = group.firstElementChild.getBoundingClientRect();
    const bounds = viewportElement.getBoundingClientRect();
    const halfWidth = button.offsetWidth / 2;
    const left =
      viewportElement.offsetLeft +
      Math.max(
        halfWidth,
        Math.min(bounds.width - halfWidth, drawing.left + drawing.width / 2 - bounds.left),
      );
    const top =
      viewportElement.offsetTop +
      Math.max(8, Math.min(bounds.height + 12, drawing.bottom - bounds.top + 12));
    setAddPosition((previous) =>
      previous?.left === left && previous.top === top ? previous : { left, top },
    );
  }, [activeDrawingId, history.present, draft, textDraft, selected, transform, viewport, natural]);
  useLayoutEffect(() => {
    // 编辑器是唯一修改状态持有者；所有关闭/切图入口只提交离开请求，不自行销毁草稿。
    onNavigationGuardChange?.((proceed) => {
      if (savePending.current || actionPending.current || pendingExit) return;
      if (dirty) {
        // Esc 可能发生在按住绘图期间：先固定可见笔画并释放捕获，防止弹窗背后继续移动或重复提交。
        const mark = draftRef.current;
        const moving = gestureRef.current?.moving;
        if (mark)
          setHistory((current) =>
            updateHistory(
              current,
              moving
                ? current.present.map((item) => (item.id === mark.id ? mark : item))
                : [...current.present, mark],
            ),
          );
        setCurrentDraft(null);
        gestureRef.current = null;
        pinch.current = null;
        const capturedPointers = [...pointers.current.keys()];
        pointers.current.clear();
        for (const id of capturedPointers) {
          if (surfaceRef.current?.hasPointerCapture(id))
            surfaceRef.current.releasePointerCapture(id);
        }
        setDragging(false);
        setPendingExit((current) => current ?? proceed);
      } else proceed();
    });
    return () => onNavigationGuardChange?.(null);
  }, [dirty, pendingExit, onNavigationGuardChange]);
  const save = async () => {
    if (savePending.current || !imageRef.current || !overlayRef.current) return;
    const target = captureImageComposerTarget();
    if (!target) {
      toast(intl.formatMessage({ id: "imageEditor.noComposer" }));
      return;
    }
    savePending.current = true;
    setSaving(true);
    try {
      const file = await exportAnnotatedImage(
        imageRef.current,
        overlayRef.current,
        filename || alt,
      );
      if (!alive.current) return;
      if (!target.append(file)) throw new Error("Composer rejected the image");
      toast(intl.formatMessage({ id: "imageEditor.addedToChat" }));
      onSaved();
    } catch (error) {
      if (!alive.current) return;
      logger.warn("[ImagePreviewDialog] 标注图片保存失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "imageEditor.saveFailed" }));
    } finally {
      savePending.current = false;
      if (alive.current) setSaving(false);
    }
  };
  return (
    <>
      <ImagePreviewActions
        src={src}
        alt={alt}
        filename={filename}
        imageRef={imageRef}
        ready={!saving && natural.width > 0}
        onAdded={onSaved}
        onBusyChange={(busy) => {
          actionPending.current = busy;
          setActionBusy(busy);
        }}
        onAddEdited={dirty ? () => void save() : undefined}
        onDownload={onDownload}
        downloading={downloading}
        zoomControls={
          <>
            <Button
              aria-label={intl.formatMessage({ id: "markdownImage.zoomOut" })}
              disabled={actionBusy || saving || transform.scale <= 0.5}
              onClick={() => zoom(transform.scale - 0.5)}
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
            >
              <MinusIcon />
            </Button>
            <button
              type="button"
              title={intl.formatMessage({ id: "preview.image.resetZoom" })}
              onClick={() => setTransform({ scale: 1, offset: ZERO })}
              className="min-w-10 text-center text-ui-sm"
            >
              {Math.round(transform.scale * 100)}%
            </button>
            <Button
              aria-label={intl.formatMessage({ id: "markdownImage.zoomIn" })}
              disabled={actionBusy || saving || transform.scale >= 3}
              onClick={() => zoom(transform.scale + 0.5)}
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
            >
              <PlusIcon />
            </Button>
          </>
        }
      >
        <div
          tabIndex={0}
          aria-label={alt}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
              }),
            );
          }}
          className="absolute inset-x-14 bottom-24 top-20 overflow-hidden sm:inset-x-16"
          data-image-preview-viewport=""
          ref={viewportRef}
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div
            data-image-preview-surface=""
            ref={surfaceRef}
            className="absolute left-1/2 top-1/2 touch-none select-none"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onLostPointerCapture={pointerEnd}
            style={{
              width: size.width,
              height: size.height,
              cursor,
              transform: `translate(-50%, -50%) translate(${transform.offset.x}px, ${transform.offset.y}px) scale(${transform.scale})`,
            }}
          >
            <img
              alt={alt}
              src={src}
              ref={imageRef}
              data-testid={imageTestId}
              draggable={false}
              className="size-full rounded-xl object-contain"
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
            <svg
              ref={overlayRef}
              className={`pointer-events-none absolute inset-0 size-full overflow-hidden text-foreground ${editing ? "" : "[&_*]:pointer-events-none!"}`}
              viewBox={`0 0 ${natural.width || 1} ${natural.height || 1}`}
              xmlns="http://www.w3.org/2000/svg"
            >
              <AnnotationLayer annotations={displayed} selected={selected} />
            </svg>
          </div>
        </div>
      </ImagePreviewActions>
      {textDraft ? (
        <div
          className="absolute left-1/2 top-20 z-30 flex max-w-full -translate-x-1/2 gap-1 rounded-xl border border-popover-border bg-popover p-2"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Input
            autoFocus
            aria-label={intl.formatMessage({ id: "imageEditor.textValue" })}
            value={textDraft.text}
            disabled={actionBusy || saving}
            className="w-48 text-mobile-input-safe sm:text-ui-base"
            onChange={(event) => setTextDraft({ ...textDraft, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (textDraft.text?.trim()) commit([...history.present, textDraft]);
                setTextDraft(null);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTextDraft(null);
              }
            }}
          />
          <Button
            onClick={() => {
              if (textDraft.text?.trim()) commit([...history.present, textDraft]);
              setTextDraft(null);
            }}
            disabled={actionBusy || saving}
          >
            {intl.formatMessage({ id: "imageEditor.applyText" })}
          </Button>
        </div>
      ) : null}
      {/* 侧边轨道预留图片外边距，收起只保留小入口；窄屏竖向滚动不遮挡顶部操作。 */}
      <div
        data-image-preview-drawing-rail=""
        className="absolute top-1/2 z-20 flex max-h-[calc(100%-10rem)] -translate-y-1/2 flex-col items-center gap-1 rounded-xl border border-popover-border bg-popover p-1 shadow-md"
        style={{ right: `max(0.5rem, calc(50% - ${size.width / 2}px - 3.25rem))` }}
      >
        <div className="shrink-0">
          <Button
            variant="ghost"
            size="icon-lg"
            title={intl.formatMessage({ id: "preview.image.annotate" })}
            aria-label={intl.formatMessage({ id: "preview.image.annotate" })}
            aria-expanded={editing}
            data-image-preview-annotate=""
            aria-pressed={editing}
            disabled={actionBusy || saving}
            onClick={() => {
              setEditing(!editing);
              setTool("select");
              setSelected(null);
              if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
              setTextDraft(null);
            }}
          >
            {editing ? <ChevronRightIcon /> : <PencilIcon />}
          </Button>
        </div>
        {editing ? (
          <ImageEditorToolbar
            tool={tool}
            onTool={(value) => {
              setTool(value);
              setSelected(null);
              if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
              setTextDraft(null);
            }}
            color={color}
            onColor={setColor}
            undo={undo}
            redo={redo}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            disabled={actionBusy || saving || !natural.width}
          />
        ) : null}
      </div>
      {dirty ? (
        <div
          className="absolute z-20 -translate-x-1/2"
          style={{ ...addPosition, visibility: addPosition ? "visible" : "hidden" }}
        >
          <Button
            ref={addButtonRef}
            data-image-preview-save=""
            variant="outline"
            size="lg"
            className="h-9 gap-2 whitespace-nowrap rounded-lg border-popover-border bg-popover px-4 text-ui-base font-medium text-foreground shadow-md hover:bg-menu-hover"
            disabled={actionBusy || saving}
            onClick={() => void save()}
          >
            <MessageSquarePlus className="size-4" />
            {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
          </Button>
        </div>
      ) : null}
      <AlertDialog
        open={Boolean(pendingExit)}
        onOpenChange={(open) => {
          if (!open && !saving) setPendingExit(null);
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            keepEditingRef.current?.focus();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (!saving) setPendingExit(null);
          }}
        >
          <AlertDialogTitle>
            {intl.formatMessage({ id: "imageEditor.unsavedTitle" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "imageEditor.unsavedDescription" })}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button
              ref={keepEditingRef}
              variant="ghost"
              disabled={saving}
              onClick={() => setPendingExit(null)}
            >
              {intl.formatMessage({ id: "imageEditor.keepEditing" })}
            </Button>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                const proceed = pendingExit;
                setPendingExit(null);
                proceed?.();
              }}
            >
              {intl.formatMessage({ id: "imageEditor.discard" })}
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
