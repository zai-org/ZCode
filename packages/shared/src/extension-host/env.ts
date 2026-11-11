import { z } from "zod";

// App 环境（docs/plugins/extension-host.md §16.11）：唯一 owner 是 Renderer（界面语言只在 Renderer）。
// 照 workbench 的报告路径：Renderer 在语言变化时报告给 Window Host，Window Host 只持最近一份，
// 扩展经能力 env.get / env.onDidChange 读。

/** BCP 47 语言标签，如 `zh-CN`、`en-US`。 */
export const extensionEnvSchema = z.strictObject({
  locale: z.string().min(2).max(35),
});
export type ExtensionEnv = z.infer<typeof extensionEnvSchema>;
