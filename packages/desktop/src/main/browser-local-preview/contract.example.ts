/**
 * browser-local-preview 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { BrowserLocalPreviewContract } from "@desktop/main/browser-local-preview/contract.js";

export async function exampleBrowserLocalPreview(
  contract: BrowserLocalPreviewContract,
): Promise<string> {
  return contract.resolveNavigation("file:///Users/dev/preview/index.html");
}
