import type { DesignRuntimeCommand, DesignRuntimeReply } from "./contract.js";
import {
  buildDesignRuntimeCommandScript,
  buildDesignRuntimeInstallScript,
  parseDesignRuntimeReply,
} from "./index.js";

/** 宿主通过任意「在页面里执行脚本」的出口驱动运行时：先安装，再发固定命令。 */
export async function goToSecondSlide(
  executeJavaScript: (script: string) => Promise<unknown>,
  bridgeKey: string,
): Promise<DesignRuntimeReply> {
  await executeJavaScript(buildDesignRuntimeInstallScript(bridgeKey));
  const command: DesignRuntimeCommand = { type: "go-to-slide", index: 1 };
  return parseDesignRuntimeReply(await executeJavaScript(buildDesignRuntimeCommandScript(command)));
}
