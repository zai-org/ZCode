import type { SupportedLocale } from "@zcode/contracts";

export type { SupportedLocale, UiLocale } from "@zcode/contracts";

export interface ZCodeCopy {
  cli: CliCopy;
  locale: SupportedLocale;
  tui: TuiCopy;
}

export interface CliCopy {
  errors: {
    localeUnsupported(value: string): string;
  };
  help(version: string): string;
}

export interface TuiCopy {
  approval: {
    /** 审批请求来自主会话之外的会话（例如 CreateSession 建的后台会话）时，面板上方的来源标注。 */
    fromSession(sessionId: string): string;
  };
  copy: {
    copied: string;
    failed: string;
    unavailable: string;
  };
  effort: {
    disabled: string;
    enabled: string;
  };
  input: {
    activeStatusHint: string;
    busyPlaceholder: string;
    placeholder: string;
    queuedMore(count: number): string;
    queuedSubmitHint: string;
    queuedTitle(count: number): string;
    title: string;
    noHistorySource: string;
    noPreviousInput: string;
    restoredPreviousInput: string;
    restoredPreviousInputWithAttachments(count: number): string;
    restorePreviousInputFailed: string;
    typePrompt: string;
  };
  loginRequired: {
    help: string;
    message: string;
    status: string;
    title: string;
  };
  loginSetup: {
    emptyMessage: string;
    help: string;
    options: {
      bigmodelApiKey: {
        inputPrimary: string;
        inputSecondary: string;
        primary: string;
        secondary: string;
      };
      bigmodelOauth: {
        pendingPrimary: string;
        pendingSecondary: string;
        primary: string;
        secondary: string;
      };
      zaiApiKey: {
        inputPrimary: string;
        inputSecondary: string;
        primary: string;
        secondary: string;
      };
      zaiOauth: {
        pendingPrimary: string;
        pendingSecondary: string;
        primary: string;
        secondary: string;
      };
    };
    pending: {
      cancelStatus: string;
      help: string;
      status: string;
    };
    input: {
      cancelStatus: string;
      clearStatus: string;
      emptyStatus: string;
      help: string;
      placeholder: string;
      status: string;
      submitStatus: string;
    };
    prompt: string;
    response: string;
    title: string;
  };
  model: {
    requestFailed(message: string): string;
    responseReceived: string;
    responseReceivedWithTokens(tokens: string): string;
    retryScheduled(input: {
      attempt: number;
      delay: string;
      maxAttempts: number;
      reason: string;
    }): string;
    streamStalled: string;
  };
  sidebar: {
    subagents: {
      title: string;
      empty: string;
      emptyOutput: string;
      back: string;
      readonly: string;
      loading: string;
      unavailable: string;
      retry: string;
      more: string;
      pendingMain: string;
      ended(count: number): string;
      status: Record<
        "running" | "waiting" | "blocked" | "success" | "failed" | "cancelled" | "lost",
        string
      >;
    };
    api: {
      empty: string;
      model: string;
      more(count: number): string;
      requests: string;
      server: string;
    };
    cache: {
      hit: string;
      lastHit: string;
      lastMiss: string;
      readWrite(input: { read: string; write: string }): string;
      total: string;
    };
    context: {
      cache: string;
      cacheReadWrite: string;
      inputOutput: string;
      reason: string;
      tokens: string;
      used: string;
      window: string;
    };
    modifiedFiles: {
      empty: string;
      more(count: number): string;
    };
    mcp: {
      empty: string;
      loadFailed: string;
      loading: string;
      more(count: number): string;
      servers: string;
      status: {
        connected: string;
        connecting: string;
        disabled: string;
        disconnected: string;
        failed: string;
        untrusted: string;
      };
      summary(input: { connected: number; total: number }): string;
      tools(count: number): string;
    };
    request: {
      complete: string;
      error: string;
      errorWithStatus(statusCode: number): string;
      pending: string;
    };
    status: {
      last: string;
    };
    run: {
      draft: string;
      draftChars(count: number): string;
      draftEmpty: string;
      messages: string;
      mode: string;
      model: string;
      provider: string;
      thought: string;
      trace: string;
      turn: string;
      workspace: string;
    };
    sections: {
      apis: string;
      context: string;
      mcp: string;
      modifiedFiles: string;
      run: string;
      status: string;
      todos: string;
    };
    shellSubtitle: string;
    title: string;
    todos: {
      empty: string;
      more(count: number): string;
      progress: string;
    };
  };
  status: {
    compactFailed: string;
    compacted: string;
    compacting: string;
    interruptedStreamDiscarded: string;
    modelCalling: string;
    permissionRequested(toolName: string): string;
    permissionResolved(toolName: string): string;
    ready: string;
    recoveringStream: string;
    retryingStream: string;
    sessionResumed: string;
    targetChanged(action: string): string;
    thinking: string;
    toolCompleted(toolName: string): string;
    toolFailed(toolName: string): string;
    toolPending(toolName: string): string;
    toolRunning(toolName: string): string;
    turnFailed: string;
  };
  terminal: {
    requiresInteractive: string;
    starting: string;
  };
  transcript: {
    compact: {
      completed: string;
      failed: string;
      interrupted: string;
      retry(command: string): string;
      retrying(input: { attempt: number; maxAttempts: number }): string;
      skipped: string;
      started: string;
    };
    roles: {
      agent: string;
      system: string;
      user: string;
    };
    thought: {
      complete: string;
      thinking: string;
    };
    title: string;
    workflow: {
      actors: string;
      actorRow(input: { name: string; status: string }): string;
      usage(input: { spentTokens: number }): string;
      collapsed(input: {
        label: string;
        status: string;
        nodesSettled: number;
        nodesTotal: number;
      }): string;
      error(message: string): string;
      expandHint: string;
      collapseHint: string;
      log: string;
      nodes(input: { nodesSettled: number; nodesTotal: number }): string;
      result(preview: string): string;
      status: {
        completed: string;
        errored: string;
        pending: string;
        running: string;
        stopped: string;
      };
      /** `stopped` 的原因词。 */
      stopReason: {
        user: string;
        model: string;
        provider: string;
        interrupted: string;
        superseded: string;
      };
      truncated: string;
      interruptedNotice(input: { label: string; runId: string }): string;
    };
  };
  selection: {
    defaultHelp: string;
    disabled(reason: string): string;
    filterLine(input: { filter: string; help?: string }): string;
    noFilter: string;
  };
  fileMention: {
    empty: string;
    loading: string;
    row(input: { path: string; selected: boolean }): string;
    title: string;
  };
  slash: {
    title: string;
    row(input: { name: string; selected: boolean; summary: string }): string;
  };
}
