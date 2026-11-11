import { appControlProtocol } from "#src/app-control/contract.js";

export const appControlListExample = appControlProtocol.listProjects.params.parse({
  callerSessionId: "root-session",
  callId: "tool-call",
  input: {},
});
