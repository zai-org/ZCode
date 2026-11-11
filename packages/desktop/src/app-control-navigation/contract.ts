import type { AppControlNavigationPort } from "@zcode/services/node";
import { z } from "zod";

export const APP_NAVIGATION_IPC = "zcode:app-control-navigation";
const identifier = z.string().min(1).max(4096);
const targetSchema = z.strictObject({
  workspacePath: identifier,
  workspaceIdentity: identifier.optional(),
  taskId: identifier,
});
const resultSchema = z.strictObject({
  status: z.enum(["opened", "unavailable"]),
  uiTarget: identifier.optional(),
  reason: z.string().optional(),
});
export const appNavigationHostMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("app-navigation-open"),
    requestId: identifier,
    uiTarget: identifier.optional(),
    target: targetSchema,
  }),
  z.strictObject({ type: z.literal("app-navigation-cancel"), requestId: identifier }),
]);
export const appNavigationResultMessageSchema = z.strictObject({
  type: z.literal("app-navigation-result"),
  requestId: identifier,
  result: resultSchema,
});
export const appNavigationRendererMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("open"),
    requestId: identifier,
    generation: identifier,
    target: targetSchema,
  }),
  z.strictObject({ type: z.literal("cancel"), requestId: identifier, generation: identifier }),
]);
export const appNavigationRendererIpcSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("register"), generation: identifier }),
  z.strictObject({ type: z.literal("unregister"), generation: identifier }),
  z.strictObject({
    type: z.literal("result"),
    generation: identifier,
    requestId: identifier,
    result: resultSchema,
  }),
]);

export type AppNavigationOpenInput = Parameters<AppControlNavigationPort["openSession"]>[0];
export type AppNavigationResult = Awaited<ReturnType<AppControlNavigationPort["openSession"]>>;
import type { AppNavigationTarget } from "@zcode/shared";
export type { AppNavigationTarget } from "@zcode/shared";
export type AppNavigationHostMessage =
  | {
      type: "app-navigation-open";
      requestId: string;
      uiTarget?: string;
      target: AppNavigationTarget;
    }
  | { type: "app-navigation-cancel"; requestId: string };
export interface AppNavigationResultMessage {
  type: "app-navigation-result";
  requestId: string;
  result: AppNavigationResult;
}
export interface AppNavigationSource {
  reply(message: AppNavigationResultMessage): void;
}
export type AppNavigationRendererMessage =
  | { type: "open"; requestId: string; generation: string; target: AppNavigationTarget }
  | { type: "cancel"; requestId: string; generation: string };
export interface AppNavigationRendererResult {
  requestId: string;
  generation: string;
  result: AppNavigationResult;
}
export interface AppControlNavigationBridge extends AppControlNavigationPort {
  receive(message: AppNavigationResultMessage): void;
  dispose(): void;
}
export interface AppControlNavigationWindow {
  register(generation: string): void;
  unregister(generation: string): void;
  open(
    source: AppNavigationSource,
    message: Extract<AppNavigationHostMessage, { type: "app-navigation-open" }>,
  ): void;
  cancel(source: AppNavigationSource, requestId: string): void;
  complete(message: AppNavigationRendererResult): void;
  detach(source: AppNavigationSource): void;
  invalidate(): void;
  dispose(): void;
}
