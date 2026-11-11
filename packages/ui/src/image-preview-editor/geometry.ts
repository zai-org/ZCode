export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Transform {
  scale: number;
  offset: Point;
}
export interface History<T> {
  past: T[][];
  present: T[];
  future: T[][];
}
export type AnnotationTool = "select" | "pen" | "text" | "rectangle" | "ellipse" | "arrow";
export interface Annotation {
  id: string;
  tool: Exclude<AnnotationTool, "select">;
  points: Point[];
  color: string;
  width: number;
  text?: string;
}
export function clampOffset(offset: Point, scale: number, image: Size, viewport: Size): Point {
  const x = Math.max(0, (image.width * scale - viewport.width) / 2);
  const y = Math.max(0, (image.height * scale - viewport.height) / 2);
  return {
    x: x ? Math.min(x, Math.max(-x, offset.x)) : 0,
    y: y ? Math.min(y, Math.max(-y, offset.y)) : 0,
  };
}
export function zoomAtPoint(transform: Transform, scale: number, anchor: Point): Transform {
  const ratio = scale / transform.scale;
  return {
    scale,
    offset: {
      x: anchor.x - (anchor.x - transform.offset.x) * ratio,
      y: anchor.y - (anchor.y - transform.offset.y) * ratio,
    },
  };
}
export function updateHistory<T>(history: History<T>, present: T[]): History<T> {
  return { past: [...history.past, history.present], present, future: [] };
}
export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  return previous
    ? {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
    : history;
}
export function redoHistory<T>(history: History<T>): History<T> {
  const next = history.future[0];
  return next
    ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) }
    : history;
}
