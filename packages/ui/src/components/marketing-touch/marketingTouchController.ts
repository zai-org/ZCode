import { createStore } from "zustand/vanilla";
import type { IMarketingTouchService } from "@zcode/services";
import type { Locale, MarketingAction, MarketingDelivery } from "@zcode/shared";
import type { CloudDialogHero } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import type { PreparedMarketingHero } from "@/components/marketing-touch/marketingResources.js";
import { logger } from "@/logger.js";

export interface PreparedMarketingDelivery {
  delivery: MarketingDelivery;
  image?: string;
  darkImage?: string;
  bannerHero?: Extract<CloudDialogHero, { type: "interactive_bundle" | "video" }>;
  hero: CloudDialogHero | null;
  success?: Promise<PreparedMarketingHero>;
  release: () => Promise<void>;
}
type Candidate = PreparedMarketingDelivery & { scope: string };
// 导出以便 controller 类型（经 MarketingTouchContext）可被 .d.ts 命名引用。
export interface MarketingTouchState {
  banner: Candidate | null;
  dialog: (Candidate & { result: boolean }) | null;
  pending: boolean;
  phase: "idle" | "verifying" | "submitting" | "preparing";
  error: string | null;
  errorAction: MarketingAction["type"] | null;
}
export type MarketingActionResult = {
  status: "success" | "cancelled" | "failure" | "uncertain";
  message?: string;
  terminal?: boolean;
};

// 左下角活动槽位的唯一可见性判断：Banner 与 ConnectedBanner 的渲染守卫共用此谓词，
// 避免仲裁层（SidebarBottomActivity）与展示层对「Banner 是否可见」出现两套判断而漂移。
// 领取 pending 期间 banner 仍非空 → 判定可见，Highspeed 分享卡继续让位。
// 用类型谓词收窄 delivery 到 banner 变体，保留调用点原有的 narrowing。
type RenderableBannerCandidate = Candidate & {
  delivery: Extract<MarketingDelivery, { resource_position: "banner" }>;
};
export function isMarketingBannerRenderable(
  banner: Candidate | null,
): banner is RenderableBannerCandidate {
  return Boolean(
    banner && banner.delivery.resource_position === "banner" && (banner.image || banner.bannerHero),
  );
}

export function createMarketingTouchController(options: {
  query: () => ReturnType<IMarketingTouchService["query"]>;
  report: IMarketingTouchService["report"];
  prepare: (delivery: MarketingDelivery) => Promise<PreparedMarketingDelivery>;
  execute: (
    action: MarketingAction,
    signal: AbortSignal,
    phase: (phase: MarketingTouchState["phase"]) => void,
  ) => Promise<MarketingActionResult>;
  locale: Locale;
  canOpen: () => boolean;
  refresh: () => void;
}) {
  const store = createStore<MarketingTouchState>(() => ({
    banner: null,
    dialog: null,
    pending: false,
    phase: "idle",
    error: null,
    errorAction: null,
  }));
  let disposed = false;
  let generation = 0;
  let snapshotScope = "";
  let lastSuccess = 0;
  let failureLogged = false;
  let deferredBanner: Candidate | null | undefined;
  let waitingPopup: Candidate | null = null;
  let waitingResult: Candidate | null = null;
  const lifetime = new AbortController();
  const key = (delivery: MarketingDelivery) =>
    `${delivery.resource_position}:${delivery.campaign_id}`;
  const release = (value: PreparedMarketingDelivery | null | undefined) => {
    if (value)
      void value.release().catch(() => logger.warn("[marketing-touch] resource release failed"));
  };
  function report(value: Candidate, actionType: "confirm" | "cancel") {
    if (disposed) return;
    void options
      .report({
        scope: value.scope,
        campaignId: value.delivery.campaign_id,
        actionType,
        locale: options.locale,
      })
      .catch(() =>
        logger.warn("[marketing-touch] action report failed", {
          campaignId: value.delivery.campaign_id,
          actionType,
        }),
      );
  }
  function invalidatePendingSnapshot() {
    // 原先按 Campaign 记录历史会拦住服务端重新投放；这里只丢弃操作前的迟到快照。
    generation++;
    release(deferredBanner);
    deferredBanner = undefined;
  }
  async function refresh() {
    const current = ++generation;
    try {
      const snapshot = await options.query();
      if (disposed || current !== generation) return;
      if (snapshotScope && snapshotScope !== snapshot.scope) {
        // 同账号凭据更新也失效旧事件上下文，已打开业务操作不移交给新凭据。
        release(waitingPopup);
        waitingPopup = null;
      }
      snapshotScope = snapshot.scope;
      failureLogged = false;
      lastSuccess = Date.now();
      const state = store.getState();
      const bannerWire = snapshot.deliveries.find((d) => d.resource_position === "banner");
      const popupWire = snapshot.deliveries.find(
        (d) =>
          d.resource_position === "popup" &&
          // 只避免当前已打开弹窗重复排队，不记录历史展示状态。
          (!state.dialog || state.dialog.result || key(state.dialog.delivery) !== key(d)),
      );
      if (!popupWire || JSON.stringify(waitingPopup?.delivery) !== JSON.stringify(popupWire)) {
        release(waitingPopup);
        waitingPopup = null;
      }
      if (!bannerWire) {
        if (state.pending) {
          release(deferredBanner);
          deferredBanner = null;
        } else {
          release(state.banner);
          store.setState({ banner: null });
        }
      }
      if (
        bannerWire &&
        state.banner &&
        !state.pending &&
        JSON.stringify(state.banner.delivery) !== JSON.stringify(bannerWire)
      ) {
        release(state.banner);
        store.setState({ banner: null });
      }
      await Promise.all(
        snapshot.deliveries.map(async (delivery) => {
          if (delivery !== bannerWire && delivery !== popupWire) return;
          if (
            delivery === bannerWire &&
            JSON.stringify(state.banner?.delivery) === JSON.stringify(delivery)
          ) {
            if (!state.pending && state.banner)
              store.setState({ banner: { ...state.banner, scope: snapshot.scope } });
            return;
          }
          if (delivery === popupWire && waitingPopup) return;
          if (disposed || current !== generation) return;
          let prepared: PreparedMarketingDelivery;
          try {
            prepared = await options.prepare(delivery);
          } catch {
            logger.warn("[marketing-touch] banner resource rejected", {
              campaignId: delivery.campaign_id,
            });
            return;
          }
          if (disposed || current !== generation) {
            release(prepared);
            return;
          }
          const candidate = { ...prepared, scope: snapshot.scope };
          if (delivery.resource_position === "banner") {
            if (store.getState().pending) {
              release(deferredBanner);
              deferredBanner = candidate;
            } else {
              release(store.getState().banner);
              store.setState({ banner: candidate });
            }
          } else {
            release(waitingPopup);
            waitingPopup = candidate;
          }
        }),
      );
    } catch (error) {
      if (!disposed && current === generation) {
        if (!failureLogged) logger.warn("[marketing-touch] query failed; keeping recent content");
        failureLogged = true;
        if (Date.now() - lastSuccess > 600_000 && !store.getState().pending) {
          release(store.getState().banner);
          store.setState({ banner: null });
        }
      }
      throw error;
    }
  }
  async function showPending() {
    const state = store.getState();
    // 错误状态先于 React 弹窗挂载；仅检查 DOM 会让等待中的投放抢先出队并叠加。
    if (
      disposed ||
      state.pending ||
      state.dialog ||
      (state.errorAction === "claim_zcode_plan" && state.error) ||
      !options.canOpen()
    )
      return;
    if (waitingResult) {
      const result = waitingResult;
      waitingResult = null;
      store.setState({ dialog: { ...result, result: true } });
      return;
    }
    if (!waitingPopup) return;
    const candidate = waitingPopup;
    waitingPopup = null;
    store.setState({ dialog: { ...candidate, result: false } });
  }
  async function run(candidate: Candidate, action: MarketingAction) {
    if (disposed || store.getState().pending) return;
    store.setState({ pending: true, phase: "verifying", error: null, errorAction: null });
    let completed = false;
    let succeeded = false;
    try {
      const result = await options.execute(action, lifetime.signal, (phase) => {
        if (!disposed) store.setState({ phase });
      });
      if (disposed) return;
      if (result.status !== "success") {
        if (
          (action.type === "claim_zcode_plan" || action.type === "open_url") &&
          (result.terminal || result.status === "uncertain")
        ) {
          completed = true;
          invalidatePendingSnapshot();
        }
        store.setState({ error: result.message ?? null, errorAction: action.type });
        return result;
      }
      completed = action.type !== "copy_text";
      succeeded = true;
      invalidatePendingSnapshot();
      report(candidate, "confirm");
      // 复制是可重复操作；不能沿用领取的完成清理，否则首次复制就会移除内容。
      if (action.type === "copy_text") return result;
      if (
        action.type !== "navigate" &&
        candidate.delivery.resource_position === "banner" &&
        candidate.delivery.banner.success_popup
      ) {
        store.setState({ phase: "preparing" });
        const prepared = await candidate.success;
        if (disposed) return;
        // 业务等待期间也可能打开别的 modal；结果排队到安全展示点，不能直接叠加。
        waitingResult = { ...candidate, hero: prepared?.hero ?? candidate.hero };
      } else {
        if (store.getState().dialog === candidate) {
          store.setState({ dialog: null });
          release(candidate);
        }
      }
      return result;
    } finally {
      if (!disposed) {
        const state = store.getState();
        const next =
          deferredBanner === undefined
            ? completed && state.banner?.release === candidate.release
              ? null
              : state.banner
            : deferredBanner;
        deferredBanner = undefined;
        if (
          state.banner &&
          state.banner.release !== next?.release &&
          state.banner.release !== state.dialog?.release &&
          state.banner.release !== waitingResult?.release
        )
          release(state.banner);
        store.setState({ pending: false, phase: "idle", banner: next });
        await showPending();
        // 只有领取会改变资格；外链等动作立即查询会与异步 confirm 竞争，使已关闭的旧弹窗重开。
        if (succeeded && action.type === "claim_zcode_plan" && !disposed) options.refresh();
      }
    }
  }
  return {
    store,
    refresh,
    showPending,
    async clickBanner() {
      const candidate = store.getState().banner;
      if (
        !candidate ||
        candidate.delivery.resource_position !== "banner" ||
        store.getState().dialog
      )
        return;
      const action = candidate.delivery.banner.buttons.find(
        (b) => b.action.type !== "close",
      )?.action;
      if (action) await run(candidate, action);
    },
    async closeBanner() {
      const candidate = store.getState().banner;
      if (!candidate || store.getState().pending) return;
      invalidatePendingSnapshot();
      store.setState({ banner: null });
      report(candidate, "cancel");
      release(candidate);
    },
    async closeDialog() {
      const dialog = store.getState().dialog;
      if (!dialog || store.getState().pending) return;
      invalidatePendingSnapshot();
      store.setState({ dialog: null });
      if (!dialog.result) report(dialog, "cancel");
      release(dialog);
    },
    async dialogAction(action: MarketingAction) {
      const dialog = store.getState().dialog;
      if (dialog) return run(dialog, action);
    },
    clearError() {
      store.setState({ error: null, errorAction: null });
    },
    dispose() {
      disposed = true;
      generation++;
      lifetime.abort();
      release(store.getState().banner);
      release(store.getState().dialog);
      release(waitingPopup);
      release(waitingResult);
      release(deferredBanner);
      store.setState({ banner: null, dialog: null, pending: false });
    },
  };
}
export type MarketingTouchController = ReturnType<typeof createMarketingTouchController>;
