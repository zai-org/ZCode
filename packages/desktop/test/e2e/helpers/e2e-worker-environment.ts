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
      /\/system-credential-(storage|owner|owner-mcp)\.test\.ts$/.test(spec.replaceAll("\\", "/")),
    )
  )
    return undefined;
  return "e2e-credential-storage";
}
