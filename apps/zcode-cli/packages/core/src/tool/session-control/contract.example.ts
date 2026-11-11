import type { CliSessionControl, CliTrustedContext } from "@zcode/session-control/contracts";
import type { SessionControlBinding } from "./contract.js";

export function bindCliSessionControl(
  control: CliSessionControl,
  trusted: CliTrustedContext,
): SessionControlBinding {
  return { kind: "cli", control, context: () => trusted };
}
