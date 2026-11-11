import { z } from "zod";

// 插件设置（docs/plugins/extension-host.md §16.7）：能力 settings.get / settings.onDidChange 的形状。
// 值是本插件 user 层的有效值（清单默认值 ⊕ user 层选项，含敏感值），owner 是 CLI。
// 只给调用方自己的插件：网关注入插件 id，入参里没有插件 id。

export const extensionSettingValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const extensionSettingsSchema = z.strictObject({
  values: z.record(z.string(), extensionSettingValueSchema),
});
export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;

// —— settings.update（§18.1 H1）：写本插件的 user 层设置 ——

/** 一次最多写或清的键数、键名与字符串值的长度上限：只防异常入参撑大 RPC 与配置文件。 */
export const EXTENSION_SETTINGS_UPDATE_MAX_KEYS = 64;
export const EXTENSION_SETTINGS_KEY_MAX_LENGTH = 128;
export const EXTENSION_SETTINGS_STRING_MAX_LENGTH = 16384;

const settingKeySchema = z.string().min(1).max(EXTENSION_SETTINGS_KEY_MAX_LENGTH);

/**
 * `values` 写入（空字符串也是值），`clear` 删除（敏感值两处都删）。至少有一项，同一个键不能既写又清。
 * 键是否属于本插件的 userConfig、值的类型是否匹配，由 Window Host 按清单校验（需要读插件清单）。
 */
export const extensionSettingsUpdateSchema = z
  .strictObject({
    values: z
      .record(
        settingKeySchema,
        z.union([
          z.string().max(EXTENSION_SETTINGS_STRING_MAX_LENGTH),
          // zod 4 的 number 本身拒绝 Infinity 与 NaN。
          z.number(),
          z.boolean(),
        ]),
      )
      .refine((values) => Object.keys(values).length <= EXTENSION_SETTINGS_UPDATE_MAX_KEYS, {
        message: `at most ${EXTENSION_SETTINGS_UPDATE_MAX_KEYS} keys`,
      })
      .optional(),
    clear: z.array(settingKeySchema).max(EXTENSION_SETTINGS_UPDATE_MAX_KEYS).optional(),
  })
  .refine((input) => Object.keys(input.values ?? {}).length > 0 || (input.clear?.length ?? 0) > 0, {
    message: "settings.update needs values or clear",
  })
  .refine((input) => !(input.clear ?? []).some((key) => Object.hasOwn(input.values ?? {}, key)), {
    message: "a key cannot be both written and cleared",
  });
export type ExtensionSettingsUpdate = z.infer<typeof extensionSettingsUpdateSchema>;
