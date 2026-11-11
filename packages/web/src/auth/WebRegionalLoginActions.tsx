import { useEffect, useRef, useState } from "react";
import { ZAI_CN_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import { Button } from "@zcode/ui/button";
import { renderOAuthProviderIcon } from "@zcode/ui/oauth-provider-icon";
import { getWebAuthCopy } from "#src/auth/webAuthLocale.js";
import type { WebOAuthProviderId } from "#src/auth/browserOAuthCredentialRepo.js";

export interface WebRegionalLoginActionsProps {
  locale?: "zh-CN" | "en-US";
  onLogin: (provider: WebOAuthProviderId, signal: AbortSignal) => Promise<void> | void;
}

export function WebRegionalLoginActions({ locale, onLogin }: WebRegionalLoginActionsProps) {
  const copy = getWebAuthCopy(locale);
  const [provider, setProvider] = useState(() => copy.defaultRegion);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);
  const cancel = () => {
    attempt.current?.abort();
    attempt.current = null;
    setPending(false);
    setFailed(false);
  };
  const submit = () => {
    if (attempt.current) return;
    const current = new AbortController();
    attempt.current = current;
    setPending(true);
    setFailed(false);
    Promise.resolve(onLogin(provider, current.signal))
      .catch(() => {
        if (attempt.current === current && !current.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (attempt.current === current) {
          attempt.current = null;
          setPending(false);
        }
      });
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="group" aria-label={copy.regionLabel}>
        {[ZAI_CN_PROVIDER_ID, ZAI_PROVIDER_ID].map((region) => (
          <Button
            key={region}
            type="button"
            variant={region === provider ? "outline" : "ghost"}
            className="flex-1"
            aria-pressed={region === provider}
            data-testid={`regional-login-${region}`}
            onClick={() => {
              cancel();
              setProvider(region);
            }}
          >
            {copy.loginRegion[region]}
          </Button>
        ))}
      </div>
      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={pending}
        data-testid="regional-login-submit"
        data-share-login-provider={provider}
        onClick={submit}
      >
        {renderOAuthProviderIcon(provider, "size-4")}
        {pending ? copy.waiting : copy.authorizeAction}
      </Button>
      {pending ? (
        <>
          <p className="text-ui-xs leading-5 text-foreground-subtle" role="status">
            {copy.authorizationHint}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            data-testid="regional-login-cancel"
            onClick={cancel}
          >
            {copy.cancelAction}
          </Button>
        </>
      ) : null}
      {failed ? (
        <p className="text-ui-xs leading-5 text-destructive" role="alert">
          {copy.callbackErrorDescription}
        </p>
      ) : null}
    </div>
  );
}
