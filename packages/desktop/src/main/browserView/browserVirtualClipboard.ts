import { randomUUID } from "node:crypto";
import type { ControlledView } from "./browserCommandTypes.js";
import {
  IAB_INPUT_TARGET_TOKEN_PROPERTY,
  VIRTUAL_PASTE_PAGE_FUNCTION,
} from "./browserVirtualClipboardPageScript.js";

export { IAB_INPUT_TARGET_TOKEN_PROPERTY } from "./browserVirtualClipboardPageScript.js";

export interface BrowserInputExecutionTarget {
  contextId?: number;
  sessionId?: string;
}

interface RuntimeResult {
  objectId?: string;
  value?: unknown;
}

interface RuntimeResponse {
  exceptionDetails?: {
    exception?: { description?: string; value?: unknown };
    text?: string;
  };
  result?: RuntimeResult;
}

interface FocusedTargetResolution {
  attachedSessionIds: string[];
  target: BrowserInputExecutionTarget;
}

const OOPIF_TARGET_REGISTRATION_TIMEOUT_MS = 1_000;

const FOCUSED_FRAME_EXPRESSION = `(() => {
  const focusedFrameElementInRoot = (root) => {
    const active = root.activeElement;
    if (active == null) return null;
    const activeWindow = active.ownerDocument.defaultView ?? window;
    if (active instanceof activeWindow.HTMLElement && active.shadowRoot != null)
      return focusedFrameElementInRoot(active.shadowRoot);
    if (
      active instanceof activeWindow.HTMLIFrameElement ||
      active instanceof activeWindow.HTMLFrameElement
    ) {
      try {
        const frameDocument =
          active.contentDocument ?? active.contentWindow?.document ?? null;
        if (frameDocument != null)
          return focusedFrameElementInRoot(frameDocument);
      } catch {}
      return active;
    }
    return null;
  };
  return focusedFrameElementInRoot(document);
})()`;

function runtimeError(response: RuntimeResponse): string | undefined {
  const exception = response.exceptionDetails;
  if (!exception) return undefined;
  return (
    exception.exception?.description ??
    (exception.exception?.value == null
      ? undefined
      : String(exception.exception.value)) ??
    exception.text ??
    "Browser Use virtual clipboard evaluation failed"
  );
}

function targetKey(target: BrowserInputExecutionTarget): string {
  return `${target.sessionId ?? "root"}:${target.contextId ?? "default"}`;
}

async function send(
  view: ControlledView,
  target: BrowserInputExecutionTarget,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return view.cdp.send(method, params, target.sessionId);
}

async function detachAttachedSessions(
  view: ControlledView,
  sessionIds: readonly string[],
): Promise<void> {
  await Promise.allSettled(
    sessionIds.map((sessionId) =>
      view.cdp.send("Target.detachFromTarget", { sessionId }),
    ),
  );
}

async function tryAttachFrameTarget(
  view: ControlledView,
  frameId: string,
): Promise<string | undefined> {
  const attached = (await view.cdp
    .send("Target.attachToTarget", { flatten: true, targetId: frameId })
    .catch(() => undefined)) as { sessionId?: string } | undefined;
  return attached?.sessionId;
}

async function waitForOopifTarget(
  view: ControlledView,
  frameId: string,
): Promise<string | undefined> {
  const deadline = Date.now() + OOPIF_TARGET_REGISTRATION_TIMEOUT_MS;
  for (;;) {
    const targets = (await view.cdp
      .send("Target.getTargets")
      .catch(() => undefined)) as
      | { targetInfos?: Array<{ targetId?: string; type?: string }> }
      | undefined;
    if (
      targets?.targetInfos?.some(
        (target) => target.targetId === frameId && target.type === "iframe",
      )
    ) {
      const sessionId = await tryAttachFrameTarget(view, frameId);
      if (sessionId) return sessionId;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
}

async function resolveFocusedTarget(
  view: ControlledView,
  initialTarget: BrowserInputExecutionTarget = {},
): Promise<FocusedTargetResolution> {
  let target = initialTarget;
  const attachedSessionIds: string[] = [];
  const visited = new Set<string>();
  try {
    for (;;) {
      const key = targetKey(target);
      if (visited.has(key))
        throw new Error("Browser Use encountered a focused frame cycle");
      visited.add(key);
      const response = (await send(view, target, "Runtime.evaluate", {
        ...(target.contextId == null ? {} : { contextId: target.contextId }),
        expression: FOCUSED_FRAME_EXPRESSION,
        returnByValue: false,
      })) as RuntimeResponse;
      if (runtimeError(response))
        throw new Error("Browser Use could not inspect the focused frame");
      const objectId = response.result?.objectId;
      if (!objectId) return { attachedSessionIds, target };
      let frameId: string | undefined;
      try {
        const described = (await send(view, target, "DOM.describeNode", {
          objectId,
        })) as {
          node?: { frameId?: string };
        };
        frameId = described.node?.frameId;
      } finally {
        await send(view, target, "Runtime.releaseObject", { objectId }).catch(
          () => undefined,
        );
      }
      if (!frameId) return { attachedSessionIds, target };

      // 同进程 iframe 与 OOPIF 不能共享顶层 execution context。先按 Chromium 的
      // OOPIF targetId=frameId 尝试 attach；失败才在当前 target 为同进程 frame 建 isolated world。
      const attachedSessionId = await tryAttachFrameTarget(view, frameId);
      if (attachedSessionId) {
        attachedSessionIds.push(attachedSessionId);
        target = { sessionId: attachedSessionId };
        await Promise.all([
          send(view, target, "Page.enable"),
          send(view, target, "Runtime.enable"),
          send(view, target, "DOM.enable"),
        ]);
        continue;
      }
      const world = (await send(view, target, "Page.createIsolatedWorld", {
        frameId,
        grantUniveralAccess: false,
        worldName: "browser-use-virtual-clipboard",
      }).catch(() => undefined)) as { executionContextId?: number } | undefined;
      if (world?.executionContextId) {
        target = { ...target, contextId: world.executionContextId };
        continue;
      }

      // OOPIF navigation 时 DOM node 的 frameId 可能先于 Target registry 可见。
      // 用有界 getTargets 轮询等待目标可用，禁止错误回落到顶层输入。
      const delayedSessionId = await waitForOopifTarget(view, frameId);
      if (!delayedSessionId)
        throw new Error(
          `Browser Use could not resolve an input target for frame ${frameId}`,
        );
      attachedSessionIds.push(delayedSessionId);
      target = { sessionId: delayedSessionId };
      await Promise.all([
        send(view, target, "Page.enable"),
        send(view, target, "Runtime.enable"),
        send(view, target, "DOM.enable"),
      ]);
    }
  } catch (error) {
    await detachAttachedSessions(view, attachedSessionIds);
    throw error;
  }
}

export async function withFocusedFrameSession<T>(
  view: ControlledView,
  run: (sessionId: string | undefined) => Promise<T>,
): Promise<T> {
  const resolution = await resolveFocusedTarget(view);
  try {
    return await run(resolution.target.sessionId);
  } finally {
    await detachAttachedSessions(view, resolution.attachedSessionIds);
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r\n", "<br>")
    .replaceAll(/[\r\n\u2028\u2029]/gu, "<br>");
}

function clipboardItems(text: string, includeRichText: boolean) {
  const entries = [{ mime_type: "text/plain", text }];
  if (includeRichText)
    entries.push({ mime_type: "text/html", text: escapeHtml(text) });
  return [{ entries, presentation_style: "unspecified" }];
}

function shouldIncludeRichText(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.host !== "docs.google.com") return true;
    return parsed.pathname.split("/").filter(Boolean)[0] !== "spreadsheets";
  } catch {
    return true;
  }
}

export function createInputTargetToken(): string {
  return randomUUID();
}

export async function assertFocusedInputTarget(
  view: ControlledView,
  target: BrowserInputExecutionTarget,
  inputTargetToken: string,
): Promise<void> {
  const response = (await send(view, target, "Runtime.evaluate", {
    ...(target.contextId == null ? {} : { contextId: target.contextId }),
    expression: `(() => {
      const deepestActiveElement = (root) => {
        const active = root.activeElement;
        if (active == null) return null;
        const view = active.ownerDocument.defaultView ?? window;
        if (active instanceof view.HTMLElement && active.shadowRoot != null)
          return deepestActiveElement(active.shadowRoot) ?? active;
        return active;
      };
      return deepestActiveElement(document)?.${IAB_INPUT_TARGET_TOKEN_PROPERTY} === ${JSON.stringify(inputTargetToken)};
    })()`,
    returnByValue: true,
  })) as RuntimeResponse;
  const error = runtimeError(response);
  if (error)
    throw new Error(
      `Browser Use could not verify the focused input target: ${error}`,
    );
  if (response.result?.value !== true)
    throw new Error("Active element is no longer the expected input target");
}

export async function pasteTextIntoFocusedTarget(
  view: ControlledView,
  text: string,
  options: {
    includeRichText?: boolean;
    initialTarget?: BrowserInputExecutionTarget;
    inputTargetToken?: string;
    replaceInputValue?: boolean;
  } = {},
): Promise<void> {
  const resolution = await resolveFocusedTarget(view, options.initialTarget);
  try {
    const includeRichText =
      options.includeRichText ?? shouldIncludeRichText(view.webContents.getURL());
    const args = {
      clipboardItems: clipboardItems(text, includeRichText),
      ...(options.inputTargetToken == null
        ? {}
        : { inputTargetToken: options.inputTargetToken }),
      replaceInputValue: options.replaceInputValue === true,
      richTextFallback: includeRichText,
    };
    const response = (await send(view, resolution.target, "Runtime.evaluate", {
      ...(resolution.target.contextId == null
        ? {}
        : { contextId: resolution.target.contextId }),
      expression: `(async () => {
        try {
          const pageFunction = ${VIRTUAL_PASTE_PAGE_FUNCTION};
          const data = await pageFunction(${JSON.stringify(args)});
          return { ok: true, data };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })) as RuntimeResponse;
    const error = runtimeError(response);
    if (error)
      throw new Error(
        `Browser Use encountered an error interacting with this webpage's clipboard: ${error}`,
      );
    const value = response.result?.value;
    if (!value || typeof value !== "object" || !("ok" in value))
      throw new Error(
        "Browser Use encountered an error interacting with this webpage's clipboard: type returned an invalid result",
      );
    if ((value as { ok?: unknown }).ok !== true) {
      const message =
        "error" in value &&
        typeof (value as { error?: unknown }).error === "string"
          ? (value as { error: string }).error
          : "type failed";
      throw new Error(
        `Browser Use encountered an error interacting with this webpage's clipboard: ${message}`,
      );
    }
  } finally {
    await detachAttachedSessions(view, resolution.attachedSessionIds);
  }
}
