import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod/v4";
import {
  DELETE_SITE_TOOL,
  RENAME_SITE_TOOL,
  SET_SITE_BADGE_TOOL,
  type SitesError,
  type SitesResult,
} from "../contract.ts";

/** 页面导航状态，经 ZCode 扩展 `ui/set-widget-state` 交给宿主内存保存，切换会话后恢复。 */
export type Route =
  | { page: "list" }
  | { page: "usage" }
  | { page: "site"; siteId: string; tab?: SiteTab }
  | { page: "deployment"; siteId: string; deploymentId: string };

/** 站点页的标签；概览不写 tab。 */
export type SiteTab = "deployments" | "analytics";

const WIDGET_STATE_KEY = "zcode/widgetState";
const SET_WIDGET_STATE = "ui/set-widget-state";
const ID = /^[1-9][0-9]{0,19}$/;

export interface SitesHost {
  context(): McpUiHostContext | undefined;
  initialRoute(): Route;
  saveRoute(route: Route): void;
  read<T>(uri: string): Promise<SitesResult<T>>;
  renameSite(siteId: string, name: string): Promise<SitesResult>;
  setBadgeHidden(siteId: string, hidden: boolean): Promise<SitesResult>;
  deleteSite(siteId: string): Promise<SitesResult>;
  openLink(url: string): void;
  copy(text: string): Promise<boolean>;
}

export async function connectHost(
  onContextChange: () => void,
): Promise<SitesHost> {
  const app = new App(
    { name: "zcode-site", version: "1" },
    {},
    { autoResize: false },
  );
  app.onhostcontextchanged = () => {
    applyContext(app.getHostContext());
    onContextChange();
  };
  await app.connect();
  applyContext(app.getHostContext());

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<SitesResult> => {
    try {
      const result = await app.callServerTool({ name, arguments: args });
      const structured = result.structuredContent;
      if (isResult(structured)) return structured;
      // 宿主拒绝（用户在审批里点了拒绝）或工具抛错时没有 structuredContent。
      return { error: { reason: "bad_response" } };
    } catch {
      return { error: { reason: "bad_response" } };
    }
  };

  return {
    context: () => app.getHostContext(),
    initialRoute: () => parseRoute(app.getHostContext()?.[WIDGET_STATE_KEY]),
    saveRoute(route) {
      void app
        .request(
          { method: SET_WIDGET_STATE, params: { widgetState: route } },
          z.looseObject({}),
        )
        .catch(() => {
          /* 旧宿主不认这个扩展方法：只是重开后回到列表。 */
        });
    },
    async read<T>(uri: string): Promise<SitesResult<T>> {
      try {
        const result = await app.readServerResource({ uri });
        const content = result.contents[0];
        const parsed: unknown =
          content && "text" in content ? JSON.parse(content.text) : undefined;
        if (isResult(parsed)) return parsed as SitesResult<T>;
      } catch {
        /* 下面统一按网络错误处理，下一轮轮询重试。 */
      }
      return { error: { reason: "network" } satisfies SitesError };
    },
    renameSite: (siteId, name) => call(RENAME_SITE_TOOL, { siteId, name }),
    setBadgeHidden: (siteId, hidden) =>
      call(SET_SITE_BADGE_TOOL, { siteId, hidden }),
    deleteSite: (siteId) => call(DELETE_SITE_TOOL, { siteId }),
    openLink(url) {
      void app.openLink({ url }).catch(() => {});
    },
    copy: copyText,
  };
}

function applyContext(context: McpUiHostContext | undefined): void {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

export function parseRoute(value: unknown): Route {
  if (typeof value !== "object" || value === null) return { page: "list" };
  const state = value as Record<string, unknown>;
  const siteId =
    typeof state.siteId === "string" && ID.test(state.siteId)
      ? state.siteId
      : "";
  const deploymentId =
    typeof state.deploymentId === "string" && ID.test(state.deploymentId)
      ? state.deploymentId
      : "";
  if (state.page === "usage") return { page: "usage" };
  if (state.page === "site" && siteId)
    return state.tab === "deployments" || state.tab === "analytics"
      ? { page: "site", siteId, tab: state.tab }
      : { page: "site", siteId };
  if (state.page === "deployment" && siteId && deploymentId)
    return { page: "deployment", siteId, deploymentId };
  return { page: "list" };
}

function isResult(value: unknown): value is SitesResult {
  return (
    typeof value === "object" &&
    value !== null &&
    ("data" in value || ("error" in value && typeof value.error === "object"))
  );
}

/** 面板资源声明了 clipboardWrite，宿主给 iframe 加了 allow="clipboard-write"；旧宿主退回 execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}
