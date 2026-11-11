import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { isLocale, type ZCodePermissionRequest } from "@zcode/shared";
import "@/styles.css";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
const params = new URLSearchParams(location.search);
const requestedLocale = params.get("locale");
const scopeGate = Promise.withResolvers<void>();
document.documentElement.classList.add(
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark",
);
const request: ZCodePermissionRequest = {
  type: "permission_request",
  taskId: "s",
  traceId: "trace",
  requestId: "p",
  kind: "Bash",
  title: "Bash",
  description: "Run command",
  raw: {
    command:
      params.get("command") === "long"
        ? `printf "%s" "${"long/path/".repeat(160)}COMMAND_END"`
        : "ping -c 4 www.baidu.com",
  },
  freeText: true,
  options: [
    { optionId: "allowOnce", kind: "allow_once", name: "Allow", response: { decision: "allow" } },
    {
      optionId: "allowAlways",
      kind: "allow_always",
      name: "Always allow in this project",
      response: {
        decision: "allow",
        permissionUpdates: [
          {
            type: "addRules",
            behavior: "allow",
            rules: [{ toolName: "Bash", ruleContent: "ping -c 4 www.baidu.com" }],
          },
        ],
      },
    },
    { optionId: "fullAccess", kind: "custom", name: "Full access", response: { decision: "deny" } },
    { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
  ],
};
// 使用移动端同一审批组件、回执账本和新建草稿入口。传输替身只控制是否真的获得授权。
function MobileProjectApproval() {
  const scope = {
    clientNamespace: innerWidth < 600 ? "mobile" : "desktop",
    hostId: "local",
    projectId: "project-a",
  };
  const [settled, setSettled] = useState(false);
  const [mode, setMode] = useState("");
  const snapshot = {
    sessionId: "s",
    config: { mode: params.get("current") ?? "build", provider: "example", model: "test" },
    pendingInteractions: [
      {
        interactionId: "p",
        payload: {
          kind: "permission",
          toolName: "Bash",
          summary: "Run command",
          detail: { command: "pwd" },
          options: [{ optionId: "allowOnce", label: "Allow", kind: "allowOnce" }],
          modeSwitch: params.get("current") === "guarded" ? "fullAccessOnly" : "choose",
          fullAccessOption: { optionId: "fullAccess", label: "Full access", kind: "custom" },
        },
      },
    ],
  } as ConversationSnapshot;
  const [sent, setSent] = useState<string[]>([]);
  const transport = {
    sendCommand: async (command) => {
      const id = (command.payload as { answer: { optionId: string } }).answer.optionId;
      setSent((previous) => [...previous, id]);
      if (params.get("mismatch") && !sent.length)
        return {
          commandId: command.commandId,
          revisionAtDecision: 1,
          status: "failed",
          reasonCode: "fault.permissionGrant.committed." + params.get("mismatch"),
        };
      setSettled(true);
      const ack: CommandAck = {
        commandId: command.commandId,
        revisionAtDecision: 1,
        status: "accepted",
        ...(params.get("grant") === "won"
          ? {
              result: {
                type: "resolveInteraction",
                resolvedBy: {
                  clientId: command.clientId,
                  optionId: (command.payload as { answer: { optionId: string } }).answer.optionId,
                },
              },
            }
          : {}),
      };
      if (params.has("queryOnly")) {
        pendingCommandRegistry.applyQuery({
          results: [
            { key: { sessionId: command.sessionId, commandId: command.commandId }, result: ack },
          ],
        });
        throw new Error("simulated lost ACK");
      }
      return ack;
    },
  } as V4ConversationContextValue;
  const open = (projectId: string) =>
    setMode(
      initializeNewTaskDraft(
        { text: "", updatedAt: 0 },
        "/example",
        undefined,
        { preferredSelection: null, providers: [] } as Parameters<typeof initializeNewTaskDraft>[3],
        { ...scope, projectId },
      ).mode!,
    );
  return (
    <V4ConversationContext.Provider value={transport}>
      {!settled && (
        <V4InteractionDialogs
          sessionId="s"
          workspacePath="/example"
          isWebRemoteControl={innerWidth < 600}
          snapshot={snapshot}
          resolveRecentScope={async () => {
            if (params.has("holdScope")) await scopeGate.promise;
            if (params.has("scopeError")) throw new Error("project.service-unavailable");
            return scope;
          }}
        />
      )}
      {params.has("holdScope") && (
        <button onClick={() => scopeGate.resolve()}>Release scope</button>
      )}
      <output data-testid="sent-options">{sent.join(",")}</output>
      {settled && (
        <>
          <button onClick={() => open("project-a")}>New A</button>
          <button onClick={() => open("project-b")}>New B</button>
          <output data-testid="draft-mode">{mode}</output>
        </>
      )}
      <ConfirmDialogHost />
    </V4ConversationContext.Provider>
  );
}

function Fixture() {
  const [response, setResponse] = useState("");
  return (
    <main className="min-h-screen bg-background text-foreground p-3">
      <PermissionDialog
        workspacePath="/example"
        request={request}
        isWebRemoteControl={innerWidth < 600}
        onRespond={(_id, option) => setResponse(option.optionId)}
      />
      <ConfirmDialogHost />
      <output data-testid="response">{response}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={isLocale(requestedLocale) ? requestedLocale : "zh-CN"}>
    {params.has("grant") ? <MobileProjectApproval /> : <Fixture />}
  </ZCodeIntlProvider>,
);
