/**
 * windows-runtime-host 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { WindowsRuntimeHost } from "#src/windows-runtime-host/contract.js";

export async function exampleWindowsRuntimeHost(runtime: WindowsRuntimeHost): Promise<void> {
  runtime.onRootExit(() => {
    /* 根退出不能释放 Job 所有权。 */
  });
  await runtime.start();
  await runtime.close(Date.now() + 3250);
}
