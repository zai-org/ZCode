import { resolveSeededReplayBaseUrl } from "./custom-openai-provider-store.js";

/** 在关键 UI 动作/运行态断言完成后释放 fixture；不修改产品时钟或生产响应。 */
export async function releaseControlledReplay(fixtureId: string): Promise<void> {
  const baseUrl = await waitForControlledReplay(fixtureId);
  const result = await fetch(`${baseUrl}/__e2e__/release/${encodeURIComponent(fixtureId)}`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  if (result.status !== 204) throw new Error(`fixture 释放失败: ${fixtureId} (${result.status})`);
}

/** 等待目标真实进入关卡；接纳回执不保证初始化及执行已开始。 */
export async function waitForControlledReplay(fixtureId: string): Promise<string> {
  const baseUrl = await resolveSeededReplayBaseUrl();
  if (!baseUrl) throw new Error("受控回放缺少本轮服务地址");
  await browser.waitUntil(
    async () => {
      const response = await fetch(`${baseUrl}/__e2e__/gates`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`读取受控流失败: ${response.status}`);
      const ids = (await response.json()) as string[];
      return ids.includes(fixtureId);
    },
    { timeout: 15_000, interval: 100, timeoutMsg: `fixture 没有进入等待释放状态: ${fixtureId}` },
  );
  return baseUrl;
}
