/**
 * useCredentials —— 凭据服务 hooks
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export function useCredentialStoreRecovery(enabled: boolean) {
  const { credentialService } = useServices();
  const [state, setState] = useState<
    | null
    | { status: "corrupt"; fingerprint: string }
    | { status: "recovered"; backupPath: string }
    | { status: "changed" }
  >(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled) {
      setState(null);
      return;
    }
    void credentialService
      .inspectStore()
      .then((result) => {
        if (generation.current === current && result?.status === "corrupt") setState(result);
      })
      .catch((error) => {
        // 权限、网络和旧 Host 不支持此能力均不是容器损坏，不能提供清空入口。
        if (generation.current === current)
          logger.warn("[credential-recovery] inspect failed", error);
      });
    return () => {
      generation.current += 1;
    };
  }, [credentialService, enabled]);
  const recover = useCallback(async () => {
    if (!enabled || state?.status !== "corrupt" || running.current) return;
    const current = generation.current;
    running.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const result = await credentialService.recoverStore(state.fingerprint);
      if (generation.current === current) setState(result);
    } catch (error) {
      if (generation.current === current) {
        logger.error("[credential-recovery] recovery failed", error);
        setFailed(true);
      }
    } finally {
      running.current = false;
      if (generation.current === current) setBusy(false);
    }
  }, [credentialService, enabled, state]);
  return { state, busy, failed, recover };
}

/** 凭据管理的基础 hook */
export function useCredentials() {
  const { credentialService } = useServices();

  const load = useCallback((key: string) => credentialService.load(key), [credentialService]);
  const save = useCallback(
    (key: string, value: string) => credentialService.save(key, value),
    [credentialService],
  );
  const del = useCallback((key: string) => credentialService.delete(key), [credentialService]);

  return { load, save, delete: del };
}

/** active provider access_token 专用便捷 hook */
export function useAuthToken() {
  const { credentialService, oauthService } = useServices();

  const getToken = useCallback(async () => {
    const activeProvider = await oauthService.getActiveProvider();
    if (!activeProvider) {
      return null;
    }

    const namespacedToken = await credentialService.load(`oauth:${activeProvider}:access_token`);
    if (namespacedToken) {
      return namespacedToken;
    }

    // 升级多 provider 前的老账号只写了 auth_token。
    // 这里补一个只针对 bigmodel 的兜底读取，避免升级后 token 读取瞬时失效。
    if (activeProvider === "bigmodel") {
      return credentialService.load("auth_token");
    }

    return null;
  }, [credentialService, oauthService]);
  const setToken = useCallback(
    async (token: string) => {
      const activeProvider = await oauthService.getActiveProvider();
      if (!activeProvider) {
        throw new Error("当前没有 active provider，无法写入 auth token");
      }
      await credentialService.save(`oauth:${activeProvider}:access_token`, token);
    },
    [credentialService, oauthService],
  );
  const clearToken = useCallback(async () => {
    const activeProvider = await oauthService.getActiveProvider();
    if (!activeProvider) {
      return;
    }
    await credentialService.delete(`oauth:${activeProvider}:access_token`);
    if (activeProvider === "bigmodel") {
      await credentialService.delete("auth_token");
    }
  }, [credentialService, oauthService]);

  return { getToken, setToken, clearToken };
}
