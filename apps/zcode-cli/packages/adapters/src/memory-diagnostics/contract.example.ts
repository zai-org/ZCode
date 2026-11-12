import { startCliMemoryDiagnostics } from "./index.js";

export function exampleMemoryDiagnostics() {
  const diagnostics = startCliMemoryDiagnostics(() => ({ sessions: 0 }));
  return () => diagnostics.stop();
}
