// 插件作者的写法（docs/plugins/extension-host.md §17.9）：按包名导入四个入口，编译期拿到与宿主相同的类型。
// 本文件随类型包一起类型检查，四个入口有一个转出错了就编译不过。
import type {
  ExtensionContext,
  ExtensionModule,
  ExtensionCapabilityOutput,
} from "@zcode-dev/plugin-api";
import type { ManifestSlots } from "@zcode-dev/plugin-api/manifest";
import type { ConversationRow } from "@zcode-dev/plugin-api/protocol-v4";
import type { SessionActionInput, SessionRowsEvent } from "@zcode-dev/plugin-api/sessions";

// 清单顶层 slots：输入框状态位的一个条目，点击执行命令。
export const exampleSlots = {
  "composer.status": [{ id: "rate", target: { command: "showRate" } }],
} satisfies ManifestSlots;

// 写动作的入参与 ctx 相同：requestId 可选，扩展进程会补一个。
export const exampleSend: SessionActionInput<"sendToSession"> = {
  sessionId: "sess_example",
  prompt: "Summarize the open sessions.",
};

/** 行事件里的完整行就是 v4 的 ConversationRow。 */
export function rowsOf(event: SessionRowsEvent): readonly ConversationRow[] {
  if (event.kind === "reset") return event.rows;
  if (event.kind === "rows") return event.upserted;
  return [];
}

export const exampleExtension: ExtensionModule = {
  activate(ctx: ExtensionContext) {
    ctx.commands.register("showRate", () => undefined);
    ctx.models.onDidGenerate((metrics: ExtensionCapabilityOutput<"models.onDidGenerate">) => {
      ctx.slots.update("rate", { text: `${Math.round(metrics.outputTokensPerSecond)} tok/s` });
    });
  },
};
