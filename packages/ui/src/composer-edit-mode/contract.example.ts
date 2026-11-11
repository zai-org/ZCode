import { composerEditSessionKey, isComposerEditScopeId } from "./contract.js";
import { createComposerEditScopeId } from "./index.js";

export function exampleComposerEditScope(workspaceKey: string, sessionId: string) {
  const scopeId = createComposerEditScopeId(sessionId);
  return {
    key: composerEditSessionKey(workspaceKey, sessionId),
    scopeId,
    isEditScope: isComposerEditScopeId(scopeId),
  };
}
