import { Emitter, type Event } from "@zcode/rpc";
import type { ExtensionEnv } from "@zcode/shared/extension-host";

// App 环境（docs/plugins/extension-host.md §16.11）：唯一 owner 是 Renderer（界面语言只在 Renderer）。
// 与 workbench 报告同一条路径：Renderer 报告，Window Host 只持最近一份，内容没变不触发。

export interface EnvState {
  report(next: ExtensionEnv): void;
  /** Renderer 还没有报告过时为 null。 */
  current(): ExtensionEnv | null;
  readonly onDidChange: Event<ExtensionEnv>;
  dispose(): void;
}

export function createEnvState(): EnvState {
  let current: ExtensionEnv | null = null;
  const changed = new Emitter<ExtensionEnv>();
  return {
    report(next) {
      if (current && current.locale === next.locale) return;
      current = next;
      changed.fire(next);
    },
    current: () => current,
    onDidChange: changed.event,
    dispose() {
      changed.dispose();
    },
  };
}
