import type { BrowserCommand, BrowserErrorCode } from "@zcode/contracts";
import { BrowserStateFileError } from "./storage-state.js";

export function abortError(): Error {
  return new DOMException("Browser command cancelled", "AbortError");
}

export async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function hasSideEffects(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return ["click", "dblclick", "fill", "press", "selectOption", "setChecked"].includes(
      command.action.operation,
    );
  }
  if (command.method === "playwright" && command.action.name === "evaluate") return true;
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "handleDialog",
    "close",
    "newTab",
    "evaluate",
  ].includes(command.method);
}

export function classifyError(error: unknown): BrowserErrorCode {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof BrowserStateFileError) return "backend_unavailable";
  if (error instanceof Error && /unavailable|closed|disconnected/iu.test(error.message)) {
    return "backend_unavailable";
  }
  return "execution_error";
}
