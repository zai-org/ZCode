import { webContents, type Session } from "electron";
import type { PluginSandboxRegistryPort } from "./contract.js";
import type { PluginSandboxPermissionGate } from "./permissionGate.js";
import { createGenUiVendorResources, resolveGenUiVendorRedirect } from "./genUiVendor.js";
import {
  createPluginSandboxProtocolHandler,
  installPluginSandboxProtocol,
  parsePluginSandboxUrl,
  type PluginSandboxAssetSource,
} from "./protocol.js";

const preparedSessions = new WeakSet<Session>();

/**
 * 每个可信 App 身份一个持久 partition（多个沙箱共享）。首次使用时把 partition session 锁死：
 * 装 protocol handler、权限交给闸门（未声明一律拒绝）、阻止下载、代理 direct。
 * desktopNetworkPolicy 覆盖 defaultSession、auto-updater 与 embedded-browser partition，沙箱 session 必须自己设。
 */
export function preparePluginSandboxSession(input: {
  session: Session;
  registry: PluginSandboxRegistryPort;
  assets: PluginSandboxAssetSource;
  /** 缺省（单测 / 未装闸门）时拒绝全部权限。 */
  permissions?: PluginSandboxPermissionGate;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}): void {
  const { session } = input;
  if (preparedSessions.has(session)) return;
  preparedSessions.add(session);
  const vendorResources = createGenUiVendorResources(input.assets.aliasDir);
  installPluginSandboxProtocol(
    session.protocol,
    createPluginSandboxProtocolHandler({
      registry: input.registry,
      assets: input.assets,
      vendorResources,
      ...(input.logger ? { logger: input.logger } : {}),
    }),
  );
  // 稳定 origin 不能授予跨实例资源访问；以 Electron 提供的实际 guest 与路径登记交叉验证。
  session.webRequest.onBeforeRequest(
    { urls: ["zcode-sandbox://*/*", "https://*/*"] },
    (details, callback) => {
      const target = parsePluginSandboxUrl(details.url);
      const guest =
        details.webContentsId === undefined ? undefined : webContents.fromId(details.webContentsId);
      const shell = guest && parsePluginSandboxUrl(guest.getURL());
      const url = new URL(details.url);
      if (url.protocol === "https:") {
        if (details.resourceType !== "script" || shell?.kind !== "shell") {
          callback({});
          return;
        }
        // 只为实际 Gen UI guest 的固定脚本改来源；重定向后的实例请求仍走下方归属校验。
        void resolveGenUiVendorRedirect(
          details.url,
          input.registry.get(shell.sandboxId),
          vendorResources,
        ).then(
          (redirectURL) => callback(redirectURL ? { redirectURL } : {}),
          () => {
            input.logger?.warn("[plugin-sandbox] Gen UI vendor manifest unavailable");
            callback({ cancel: true });
          },
        );
        return;
      }
      // shell 的打包 / dev 绝对资源 URL 重定向到同一 guest 的实例路径，顶层站点保持稳定。
      if (!target && shell?.kind === "shell") {
        const record = input.registry.get(shell.sandboxId);
        if (record && url.hostname === `shell-${record.instance.appIdentity}`) {
          callback({
            redirectURL: `${url.protocol}//${url.host}/instance/${record.sandboxId}${url.pathname}${url.search}`,
          });
          return;
        }
      }
      if (target?.kind === "shell") {
        const record = input.registry.get(target.sandboxId);
        // 首次主文档已由 will-attach 绑定；后续资源必须仍属于这个实际 guest。
        const initial =
          details.resourceType === "mainFrame" && (!shell || shell.sandboxId === target.sandboxId);
        callback({
          cancel:
            !record ||
            url.hostname !== `shell-${record.instance.appIdentity}` ||
            (!initial && shell?.sandboxId !== target.sandboxId),
        });
        return;
      }
      const record = target && input.registry.get(target.sandboxId);
      callback({
        cancel:
          !record ||
          !shell ||
          shell.kind !== "shell" ||
          shell.sandboxId !== record.sandboxId ||
          url.hostname !== `plugin-${record.instance.appIdentity}`,
      });
    },
  );
  const gate = input.permissions;
  session.setPermissionRequestHandler((guest, permission, callback, details) => {
    if (!gate) {
      input.logger?.warn(`[plugin-sandbox] permission blocked: ${permission}`);
      callback(false);
      return;
    }
    const guestUrl = guest.getURL();
    const frame = guest.mainFrame.frames.find((child) => child.url === details.requestingUrl);
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    void gate
      .request({
        permission,
        guestUrl,
        isCurrent: () =>
          !guest.isDestroyed() &&
          guest.getURL() === guestUrl &&
          Boolean(frame && !frame.detached && guest.mainFrame.frames.includes(frame)),
        requestingUrl: details.requestingUrl,
        ...(mediaTypes ? { mediaTypes } : {}),
      })
      .then(callback, (error: unknown) => {
        input.logger?.warn(`[plugin-sandbox] permission request failed: ${String(error)}`);
        callback(false);
      });
  });
  session.setPermissionCheckHandler((guest, permission, requestingOrigin, details) => {
    if (!gate) return false;
    const mediaType = (details as { mediaType?: string }).mediaType;
    return gate.check({
      guestUrl: guest?.getURL(),
      permission,
      requestingOrigin,
      ...(mediaType ? { mediaType } : {}),
    });
  });
  session.on("will-download", (event) => {
    event.preventDefault();
    input.logger?.warn("[plugin-sandbox] download blocked");
  });
  void session.setProxy({ mode: "direct" }).catch(() => undefined);
}
