import { type CliSessionControl, type CliTrustedContext } from "#session-control/contract";

export async function sendAndObserve(
  control: CliSessionControl,
  ctx: CliTrustedContext,
): Promise<void> {
  const receipt = await control.sendToSession(ctx, {
    session: { kind: "cli", workspacePath: "/workspace/example", sessionId: "target-session" },
    prompt: "Run the affected checks",
    requestId: "tool-call-stable-request",
  });
  if (receipt.admission !== "accepted") return;
  await control.waitSessions(ctx, {
    operations: [receipt.operation],
    mode: "all",
    timeoutMs: 30_000,
  });
}
