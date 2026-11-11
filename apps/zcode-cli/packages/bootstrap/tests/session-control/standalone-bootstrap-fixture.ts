export const CLI_TOOLS = [
  "ListSessions",
  "ReadSession",
  "CreateSession",
  "ForkSession",
  "SendToSession",
  "WaitSessions",
  "InterruptSession",
  "RenameSession",
];

export const APP_ONLY_TOOLS = [
  "ListProjects",
  "OpenSession",
  "SetSessionArchived",
  "SetSessionPinned",
];

export const cleanups: Array<() => Promise<void>> = [];
