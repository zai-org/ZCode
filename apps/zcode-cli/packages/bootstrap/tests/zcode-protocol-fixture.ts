import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import { type ExecutionShellSelection } from "@zcode/contracts";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import { answerReplyLanguageRequest } from "./helpers/fake-host-requests.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

export const workspace = {
  workspacePath: "/workspace/app",
  workspaceKey: "/workspace/app",
};

export async function requestResult(
  server: ZCodeProtocolAgentServer,
  message: ZCodeProtocolMessage,
) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

export function attachSessionRuntimePreferencesResponder(
  server: ZCodeProtocolAgentServer,
  resolvePreferences: (scope: "runtime-materialization" | "user-execution") => {
    nativeSearchEnhancementsEnabled: boolean;
    toolSearchMode?: "auto" | "local" | "off";
    totalTokensReminderEnabled?: boolean;
    agentAlwaysBackgroundEnabled?: boolean;
    memoryEnabled?: boolean;
    subagentRuntimeConfigEnabled?: boolean;
    modelContextBudgetStrategy?: "legacy" | "preflight-v1";
    integratedTerminalShell?:
      | {
          mode: "auto";
        }
      | {
          mode: "shell";
          dialect: "git-bash" | "cmd";
          id: string;
          label: string;
          path: string;
        };
  },
): ZCodeProtocolMessage[] {
  const requests: ZCodeProtocolMessage[] = [];
  server.setNotificationSink((message) => {
    if (answerReplyLanguageRequest(server, message)) return;
    if (
      "id" in message &&
      message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
    ) {
      requests.push(message);
      const scope = (message.params as { scope: "runtime-materialization" | "user-execution" })
        .scope;
      void server.handleMessage({
        id: message.id,
        result: resolvePreferences(scope),
      });
    }
  });
  return requests;
}

export type ShellInitializationCandidate = Parameters<
  ZCodeApp["runtime"]["initializeSessionShellEnvironmentIfNeeded"]
>[0];

export function resolveShellInitializationCandidate(
  candidate: ShellInitializationCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}

export function createShellRecordingFakeApp(
  options: ZCodeAppOptions,
  shellInitializations: unknown[],
  createdAppOptions?: ZCodeAppOptions[],
): ZCodeApp {
  createdAppOptions?.push(options);
  const app = createFakeApp(options);
  let effectiveShellSelection = options.runtimeConfig?.bashShellSelection;
  let shellInitialized = effectiveShellSelection !== undefined;
  let shellInitializationPromise: Promise<void> | undefined;
  const recordShellInitialization = (selection: ShellInitializationCandidate) => {
    if (shellInitialized) {
      return false;
    }
    const resolvedSelection = resolveShellInitializationCandidate(selection);
    effectiveShellSelection = resolvedSelection;
    shellInitialized = true;
    shellInitializations.push(resolvedSelection);
    return true;
  };
  const initializeFromStartupPreferences = async () => {
    if (shellInitialized) {
      return;
    }
    shellInitializationPromise ??= (async () => {
      const selection = await options.resolveInitialBashShellSelection?.();
      if (selection) {
        recordShellInitialization(selection);
      }
    })();
    await shellInitializationPromise;
  };
  return {
    ...app,
    resume: async (resumeOptions) => {
      await initializeFromStartupPreferences();
      return app.resume(resumeOptions);
    },
    runtime: {
      ...app.runtime,
      getSessionShellSelection: () => effectiveShellSelection,
      initializeSessionShellEnvironmentIfNeeded: recordShellInitialization,
    } as never,
    sendInput: async (input, sendOptions) => {
      await initializeFromStartupPreferences();
      return app.sendInput(input, sendOptions);
    },
  };
}
