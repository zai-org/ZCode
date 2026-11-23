/** 旧统一面板已移除；浮层挂在 Portal 中，不能在 pane 子树内查找。 */
export async function openStatusCapsule(
  kind: "goal" | "todo" | "git" | "activity",
  timeout = 30000,
  paneId = "workspace-main",
): Promise<void> {
  const trigger = $(`[data-testid="v4-session-pane-${paneId}"] [data-status-capsule="${kind}"]`);
  await trigger.waitForDisplayed({ timeout });
  if ((await trigger.getAttribute("data-state")) !== "open") await trigger.click();
  await $(`[data-status-capsule-content="${kind}"]`).waitForDisplayed({ timeout });
}
