import { z } from "zod";

// 能力 models.list 的返回（docs/plugins/extension-host.md §18.1 H9）：与输入框模型选择器同一份视图。

export const extensionModelSchema = z.strictObject({
  /** `<providerId>/<modelId>`。模型 id 里可能有 `/`：要分开用时读 providerId 与 modelId，不要拆 id。 */
  id: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /** 与选择器相同，就是 modelId（模型配置没有显示名）。 */
  label: z.string().min(1),
  /** provider 的显示名；没有时为 providerId。 */
  providerName: z.string().min(1),
});
export type ExtensionModel = z.infer<typeof extensionModelSchema>;

export const extensionModelListSchema = z.array(extensionModelSchema);
