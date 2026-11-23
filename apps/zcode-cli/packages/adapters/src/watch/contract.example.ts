/**
 * live-config-watch 标准调用示例：一个领域加载器接到进程级 registry 上。
 */
import { createRefcountedRegistry, createWatchedEntry } from "./watched-source.js";
import type { WatchedLoad } from "./contract.js";

interface ExampleLoad extends WatchedLoad {
  value: string;
}

export function exampleLiveConfigWatch(load: () => Promise<ExampleLoad>) {
  return createRefcountedRegistry({
    label: "Example source",
    key: (options: { root: string }) => options.root,
    // 每次全量读取并登记依赖的文件与目录；只有被采纳时才 commit。
    create: (options) => createWatchedEntry({ load, bounds: [options.root], label: "Example" }),
    view: (entry, _options, release) => ({ read: () => entry.current().value, close: release }),
  });
}
