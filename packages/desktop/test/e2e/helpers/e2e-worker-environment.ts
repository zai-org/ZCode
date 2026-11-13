const ASK_USER_QUESTION_AUTO_RESOLUTION_SETTING_SPEC =
  "conversation-session-ask-user-question-auto-resolution-setting.test.ts";

export function resolveAskUserQuestionClockScaleForWorker({
  requestedScale,
  specs,
}: {
  requestedScale?: string;
  specs: readonly string[];
}): string | undefined {
  const normalizedRequestedScale = requestedScale?.trim();
  if (normalizedRequestedScale) return normalizedRequestedScale;
  return specs.some((spec) =>
    spec.replaceAll("\\", "/").endsWith(`/${ASK_USER_QUESTION_AUTO_RESOLUTION_SETTING_SPEC}`),
  )
    ? "20"
    : undefined;
}

/** 合成凭据测试不访问开发者钥匙串；原生存储专项必须走真实系统后端。 */
export function resolveE2ECredentialSecret(
  specs: readonly string[],
  configured?: string,
): string | undefined {
  if (configured) return configured;
  if (
    specs.some((spec) =>
      /\/system-credential-(storage|data-root|owner|owner-mcp)\.test\.ts$/.test(
        spec.replaceAll("\\", "/"),
      ),
    )
  )
    return undefined;
  return "e2e-credential-storage";
}

/**
 * 访问真实 macOS 钥匙串的专项：Main 启动前要把隔离 HOME 的 Keychains 链到系统目录。
 * owner 专项使用原生 API 边界替身，不需要链接。
 */
export function isNativeKeychainCredentialSpec(spec: string): boolean {
  return /\/system-credential-(storage|data-root)\.test\.ts$/.test(spec.replaceAll("\\", "/"));
}
