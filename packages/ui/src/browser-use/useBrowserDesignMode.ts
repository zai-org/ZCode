import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IFileService } from "@zcode/services";
import { browserPreviewSourceUrl } from "@zcode/shared";
import {
  buildCssVariableTweakControls,
  DESIGN_PAGE_LIMITS,
  formatTweakValue,
  type DesignInteractionMode,
  type DesignPageInfo,
  type DesignPageSignals,
  type DesignRuntimeCommand,
  type DesignRuntimeEvent,
  type DesignSelectedElement,
  type PageElementRect,
} from "@zcode/design-runtime";
import {
  DESIGN_STYLE_CSS_NAMES,
  toDesignPageKey,
  type DesignStyleProperty,
} from "@/browser-use/browserDesignProperties.js";
import {
  useBrowserDesignRuntime,
  type DesignRuntimeWebview,
} from "@/browser-use/useBrowserDesignRuntime.js";
import { useBrowserDesignSourceWriter } from "@/browser-use/useBrowserDesignSourceWriter.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createWebElementContextId,
  dispatchWebElementContextAddToChat,
  dispatchWebElementContextRemoveFromChat,
  subscribeWebElementContextsRemoved,
} from "@/lib/webElementContext.js";
import { logger } from "@/logger.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";

const DESIGN_PLUGIN_ID = "design@zcode-plugins-official";

// 设计工具的状态 owner（docs/browser-use/2026-11-03-browser-design-mode-spec.md）：每个浏览器 tab 一份。
// 选中集合以页面运行时上报的为准（宿主只镜像）；选中的元素作为网页元素引用进输入框；
// 属性面板改的数值经 useBrowserDesignSourceWriter 直接写回源文件，撤销也在那里。

/** 元素引用投到哪个 workspace 的输入框（与 Agent tab「选择元素」同一个出口） */
export interface DesignChipTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

function isLocalPage(url: string): boolean {
  try {
    // 本机 HTML 在 webview 里是 zcode-html:// 预览地址，先还原成源 file:// 再判断
    const { hostname, protocol } = new URL(browserPreviewSourceUrl(url));
    return (
      protocol === "file:" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * 设计工具自动出现的条件：页面带 `data-zcode-design`；或是本机页面（file:// / localhost）且有
 * :root CSS 变量、data-variant 方案或 section.slide。普通网站很多也声明 :root 变量，所以只对本机页面看这几项。
 */
export function shouldAutoShowDesignTools(signals: DesignPageSignals, pageUrl: string): boolean {
  if (signals.isDesignDocument) return true;
  return (
    isLocalPage(pageUrl) &&
    (signals.cssVariableNames.length > 0 || signals.variants.length > 0 || signals.slideCount > 0)
  );
}

const selectorOf = (selection: DesignSelectedElement) => selection.element.selector ?? "";

/**
 * 元素引用对账是串行的：一步卡住，之后所有点选都进不了输入框（11-05 实机复现过）。
 * webview 的 executeJavaScript 在页面导航时可能永远不返回，所以给页面命令和截图各设一个上限，
 * 超时按失败处理（读不到文档令牌就不加这次的引用，截图超时就只带文字）。main 取帧自己有 15 秒超时，这里略长。
 */
const PAGE_COMMAND_DEADLINE_MS = 3_000;
const CAPTURE_DEADLINE_MS = 20_000;

function withDeadline<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export function useBrowserDesignMode({
  captureElement,
  chipTarget,
  currentUrl,
  fileService,
  onSelectModeStart,
  isVisible,
  probeEnabled,
  remoteSessionId,
  workspaceIdentity,
  webview,
  webviewGeneration,
}: {
  /** 按视口 rect 由 main 取帧裁剪；宿主不支持时为 undefined，引用只带文字 */
  captureElement?: (rect: PageElementRect) => Promise<ArrayBuffer | null>;
  /** 没有 workspace（Agent tab 等）时为 null，点选不进输入框 */
  chipTarget: DesignChipTarget | null;
  currentUrl: string;
  /** 写回本机源文件用的文件服务（file:// 一律走本机） */
  fileService: IFileService | undefined;
  /** 进入点选前回调，宿主据此取消正在进行的元素 chip 选择（两者都拦截页面点击） */
  onSelectModeStart?: () => void;
  isVisible: boolean;
  probeEnabled: boolean;
  remoteSessionId?: string | null;
  workspaceIdentity?: string;
  webview: DesignRuntimeWebview | null;
  webviewGeneration: number;
}) {
  const { intl } = useZCodeIntl();
  const pageKey = toDesignPageKey(currentUrl);
  // 元素引用的 workspaceKey 在本地也有值，不能把它当远程身份，否则本地查询会走断连代理。
  const {
    services: { pluginManagementService },
    rpcReady,
  } = useWorkspaceServicesResolution(chipTarget?.workspacePath, remoteSessionId, workspaceIdentity);
  const pluginStore = useScopedPluginManagementStore(pluginManagementService);
  const pluginEnabled = pluginStore(
    (state) =>
      state.workspacePath === chipTarget?.workspacePath &&
      state.workspaceIdentity === (workspaceIdentity?.trim() || null) &&
      state.plugins.some((plugin) => plugin.id === DESIGN_PLUGIN_ID && plugin.enabled),
  );
  const initializePlugin = useCallback(async () => {
    if (!probeEnabled || !chipTarget || !rpcReady) return;
    await pluginStore.getState().initialize({
      workspacePath: chipTarget.workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [chipTarget, pluginManagementService, pluginStore, probeEnabled, rpcReady, workspaceIdentity]);
  useEffect(() => {
    void initializePlugin();
  }, [initializePlugin]);
  const confirm = useConfirmDialog();
  const pendingSelection = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      // 插件查询和安装提示属于发起的 tab/页面；切换后不能用旧结果导航或进入点选。
      pendingSelection.current?.abort();
      pendingSelection.current = null;
    },
    [chipTarget, isVisible, pageKey, pluginManagementService, workspaceIdentity],
  );
  const [signals, setSignals] = useState<{ pageKey: string; signals: DesignPageSignals } | null>(
    null,
  );
  const [mode, setModeState] = useState<DesignInteractionMode>("off");
  const [panelOpen, setPanelOpen] = useState(false);
  const [pageInfo, setPageInfo] = useState<DesignPageInfo | null>(null);
  const [selections, setSelections] = useState<readonly DesignSelectedElement[]>([]);
  /** 选中的元素都能在源码里找到（能直接写回）；null 表示还在查 */
  const [writable, setWritable] = useState<boolean | null>(null);
  /** 主选中元素的文字能不能在面板里改（源码里只含文字） */
  const [textWritable, setTextWritable] = useState(false);
  /** 源文件读不了（不是 UTF-8、太大、读报错）：面板说明原因，不当成「元素对不上」 */
  const [sourceUnreadable, setSourceUnreadable] = useState(false);
  const [variablePreview, setVariablePreviewState] = useState<Record<string, string>>({});
  const [variant, setVariantState] = useState<string | null>(null);
  const [slide, setSlide] = useState({ index: 0, count: 0 });

  const autoToolsVisible =
    signals?.pageKey === pageKey && shouldAutoShowDesignTools(signals.signals, currentUrl);
  // 设计稿页面（设计产物）才出设计工具行、深色画布、方案和翻页
  const toolsVisible = probeEnabled && pluginEnabled && autoToolsVisible;
  // 人类 tab 的「选择元素」在任何页面上都是这套点选（11-06 统一，取代原来的元素选择器）：
  // 普通网页开着点选时也装运行时，调整面板按页面能不能写回决定可改还是只读
  const runtimeActive = pluginEnabled && (toolsVisible || (probeEnabled && mode !== "off"));

  // 异步回调（注入完成、截图回来、写回完成）读最新值，不依赖闭包里的旧 state
  const latest = useRef({ mode, selections, variablePreview, variant, pageKey });
  latest.current = { mode, selections, variablePreview, variant, pageKey };
  const runRef = useRef<((command: DesignRuntimeCommand) => Promise<unknown>) | null>(null);
  const runLatest = useCallback(
    (command: DesignRuntimeCommand) => runRef.current?.(command) ?? Promise.resolve(null),
    [],
  );

  const pushVariables = useCallback(
    (values: Record<string, string>) => {
      latest.current.variablePreview = values;
      setVariablePreviewState(values);
      void runLatest({ type: "set-css-variables", values });
    },
    [runLatest],
  );
  const setVariablePreview = useCallback(
    (name: string, value: string | null) => {
      const next = { ...latest.current.variablePreview };
      if (value === null) delete next[name];
      else next[name] = value;
      pushVariables(next);
    },
    [pushVariables],
  );

  const writer = useBrowserDesignSourceWriter({
    fileService,
    pageKey,
    pageUrl: currentUrl,
    run: runLatest,
    setVariablePreview,
  });
  const { checkWritable } = writer;

  // ---- 选中 → 输入框里的元素引用 ----
  // 选中集合变了就对一次账：取消选中的撤回，新选中的截图后加进去。串行执行，同一元素不会加两次；
  // 截图期间又取消了选中或页面换了文档，就不加（下一次对账按当时的选中再算）。
  const chipsRef = useRef(new Map<string, string>());
  // 没有可接收的输入框时只提示一次：同一轮点选里写回 / 撤销会反复重读选中，不再重复弹（detachChips 时复位）
  const noTargetNotifiedRef = useRef(false);
  const chipQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // Bugfix（11-05「点中元素不进输入框」）：对账是串行队列，页面导航 / 自动刷新时 webview 的 executeJavaScript
  // 可能永远不返回，卡住的那一步让之后所有选中都进不了输入框。每份新文档（运行时装好）换一代、队列从头开始，
  // 旧任务在每个 await 之后发现代际变了就退出。
  const chipGenerationRef = useRef(0);
  const enqueueChips = useCallback((task: (alive: () => boolean) => Promise<void>) => {
    const generation = chipGenerationRef.current;
    chipQueueRef.current = chipQueueRef.current
      .then(() => task(() => chipGenerationRef.current === generation))
      .catch((error: unknown) => {
        logger.warn("[BrowserDesign] 元素引用对账失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);
  const resetChipQueue = useCallback(() => {
    chipGenerationRef.current += 1;
    chipQueueRef.current = Promise.resolve();
  }, []);
  const captureSelection = useCallback(
    async (selector: string): Promise<ArrayBuffer | null> => {
      if (!captureElement || !selector) return null;
      try {
        const rect = (await runLatest({
          type: "locate-for-capture",
          selector,
        })) as PageElementRect | null;
        if (!rect || rect.width <= 0 || rect.height <= 0) return null;
        return await captureElement(rect);
      } catch (error) {
        // 截图只是附加信息：失败时引用照常只带文字
        logger.warn("[BrowserDesign] 元素截图失败，只附加文字", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        await runLatest({ type: "end-capture" });
      }
    },
    [captureElement, runLatest],
  );
  // 选中变了就当场对账（同步）：取消选中的撤回、新选中的马上以文字引用加进输入框；
  // 截图慢（main 取帧可能要十几秒），放进串行队列，回来后按同一 id 补到那条引用上，引用不等截图（11-05 反馈）。
  const reconcileChips = useCallback(() => {
    // 没有可接收的输入框（没有工作区，或输入框不收引用）：每轮点选只提示一次（!3548 第四、五轮）
    const notifyNoTarget = () => {
      if (noTargetNotifiedRef.current) return;
      noTargetNotifiedRef.current = true;
      toast(intl.formatMessage({ id: "browser.design.contextUnavailable" }), {
        variant: "warning",
        position: "bottom-center",
        dedupeKey: "browser-design-context-unavailable",
      });
    };
    if (!chipTarget) {
      if (latest.current.selections.length > 0) notifyNoTarget();
      return;
    }
    const wanted = new Set(latest.current.selections.map(selectorOf));
    for (const [selector, id] of chipsRef.current) {
      if (wanted.has(selector)) continue;
      dispatchWebElementContextRemoveFromChat({ id, ...chipTarget });
      chipsRef.current.delete(selector);
    }
    let accepted = false;
    let rejected = false;
    for (const selection of latest.current.selections) {
      const selector = selectorOf(selection);
      if (!selector || chipsRef.current.has(selector)) continue;
      const id = createWebElementContextId();
      // inline：在输入框正文里以元素 token 出现（像 Skill 一样能穿插文字）
      const payload = { ...selection.element, id, ...chipTarget, inline: true };
      if (!dispatchWebElementContextAddToChat(payload)) {
        rejected = true;
        notifyNoTarget();
        continue;
      }
      accepted = true;
      chipsRef.current.set(selector, id);
      enqueueChips(async (alive) => {
        const readToken = () =>
          withDeadline(runLatest({ type: "read-document-token" }), PAGE_COMMAND_DEADLINE_MS, null);
        const token = await readToken();
        if (!alive() || chipsRef.current.get(selector) !== id) return;
        const screenshot = await withDeadline(
          captureSelection(selector),
          CAPTURE_DEADLINE_MS,
          null,
        );
        if (!alive() || !screenshot || chipsRef.current.get(selector) !== id) return;
        // 截图期间页面换了文档：截到的可能是另一个页面，不补
        if (typeof token !== "string" || (await readToken()) !== token) return;
        if (!alive() || chipsRef.current.get(selector) !== id) return;
        dispatchWebElementContextAddToChat(
          { ...payload, screenshot: { data: screenshot, mimeType: "image/png" } },
          { updateOnly: true },
        );
      });
    }
    // 这一轮全都收下了才复位：之后再收不下要重新提示；有成有败时不复位，免得下次重读又弹
    // （界面点选每次对账只新增一个元素，「有成有败」是兜底，如恢复多选后输入框只拒其中不合法的一条）
    if (accepted && !rejected) noTargetNotifiedRef.current = false;
  }, [captureSelection, chipTarget, enqueueChips, intl, runLatest]);
  /** 退出点选、换页面：已进输入框的引用留着，只是不再跟着选中变 */
  const detachChips = useCallback(() => {
    chipsRef.current.clear();
    noTargetNotifiedRef.current = false;
  }, []);

  // 输入框里的引用被删掉 / 发出：页面这边同步（输入框与选中保持一致）
  useEffect(() => {
    if (!chipTarget) return;
    return subscribeWebElementContextsRemoved(chipTarget, (ids, reason) => {
      const removed = new Set<string>();
      for (const [selector, id] of chipsRef.current) {
        if (ids.includes(id)) removed.add(selector);
      }
      if (removed.size === 0) return;
      for (const selector of removed) chipsRef.current.delete(selector);
      // 随消息发出：只忘掉引用，选中留着（再点同一元素会重新引用）；用户删掉：页面上一起取消选中
      if (reason !== "user") return;
      const selectors = latest.current.selections
        .map(selectorOf)
        .filter((selector) => !removed.has(selector));
      void runLatest({ type: "set-selection", selectors });
    });
  }, [chipTarget, runLatest]);

  // ---- 选中能不能写回：每次选中变了按当前源码查一次，结果对不上当前选中就丢掉 ----
  const checkGenerationRef = useRef(0);
  const checkedKeyRef = useRef("");
  const refreshWritable = useCallback(
    (items: readonly DesignSelectedElement[]) => {
      const generation = ++checkGenerationRef.current;
      if (items.length === 0) {
        checkedKeyRef.current = "";
        setWritable(null);
        setTextWritable(false);
        return;
      }
      // 同一组元素重读（写回、撤销后）时保留上次结果，面板不闪「正在对应源码」
      const key = items.map(selectorOf).join("\n");
      if (key !== checkedKeyRef.current) setWritable(null);
      checkedKeyRef.current = key;
      void checkWritable(items).then(({ elements, readable }) => {
        if (generation !== checkGenerationRef.current) return;
        const all = readable && elements.every((element) => element.located);
        setWritable(all);
        setSourceUnreadable(!readable);
        // 面板里改文字只在单选且源码里该元素只含文字时开（!3450 SG-01）
        setTextWritable(all && elements.length === 1 && elements[0]?.textWritable === true);
      });
    },
    [checkWritable],
  );

  const applySelections = useCallback(
    (items: readonly DesignSelectedElement[]) => {
      latest.current.selections = items;
      setSelections(items);
      // 点中元素就打开属性面板显示它（关过面板也一样，11-05 反馈）
      if (items.length > 0) setPanelOpen(true);
      refreshWritable(items);
      reconcileChips();
    },
    [reconcileChips, refreshWritable],
  );

  // 写回 / 撤销之后按选择器重新读一遍选中元素：面板显示的是页面上的实际值（唯一来源），不在宿主侧拼
  const rereadSelections = useCallback(() => {
    const selectors = latest.current.selections.map(selectorOf);
    if (selectors.length > 0) void runLatest({ type: "set-selection", selectors });
  }, [runLatest]);
  const {
    commitElements: writeElements,
    commitVariable,
    isOwnWrite,
    undo: undoWrite,
    redo: redoWrite,
  } = writer;
  // 写回失败时页面由 writer 按这次读到的源码撤回（!3450 SG-02、Q-design-rollback-baseline）；
  // 换了页面的过期任务（stale）什么都不动，连重读也不发
  const commitElements = useCallback(
    async (edits: Parameters<typeof writeElements>[0]) => {
      const result = await writeElements(edits);
      if (result !== "stale") rereadSelections();
      return result;
    },
    [rereadSelections, writeElements],
  );
  const undo = useCallback(async () => {
    if ((await undoWrite()) === "written") rereadSelections();
  }, [rereadSelections, undoWrite]);
  const redo = useCallback(async () => {
    if ((await redoWrite()) === "written") rereadSelections();
  }, [redoWrite, rereadSelections]);

  const handleEvent = useCallback(
    (event: DesignRuntimeEvent) => {
      switch (event.type) {
        case "selection-changed":
          applySelections(event.selections);
          return;
        case "slide-changed":
          setSlide({ index: event.index, count: event.count });
          return;
        case "mode-changed":
          // 页面里按 Esc 退出点选
          if (event.mode === "off") {
            setModeState("off");
            setPanelOpen(false);
            void runLatest({ type: "set-selection", selectors: [] });
            detachChips();
          }
          return;
        case "stage-changed":
          // resize 后舞台判断变了：宿主的外框与 webview 底色跟着页面走（!3450 CR-02）
          setPageInfo((info) => (info ? { ...info, stageBackdrop: event.stageBackdrop } : info));
          return;
      }
    },
    [applySelections, detachChips, runLatest],
  );

  const lastInstalledKeyRef = useRef<string | null>(null);
  const handleInstalled = useCallback(
    (info: DesignPageInfo) => {
      setPageInfo(info);
      setSlide({ index: info.currentSlide, count: info.slideCount });
      const run = runRef.current;
      const state = latest.current;
      const infoKey = toDesignPageKey(info.pageUrl);
      const switchedPage =
        lastInstalledKeyRef.current !== null && lastInstalledKeyRef.current !== infoKey;
      const samePage = lastInstalledKeyRef.current === infoKey;
      // 新文档：之前排队的对账（可能卡在旧文档的命令上）全部作废
      resetChipQueue();
      lastInstalledKeyRef.current = infoKey;
      // 刷新后源码就是事实：之前的变量预览值要么已经写进源码，要么被别人改掉了，都不再盖在页面上
      latest.current.variablePreview = {};
      setVariablePreviewState({});
      // 换到另一个页面：退出点选、收起面板、方案复位，和进新页面时一样从头开始（!3548 CR-01）
      if (switchedPage) {
        latest.current.mode = "off";
        latest.current.variant = null;
        setModeState("off");
        setPanelOpen(false);
        setVariantState(null);
      }
      // 换了页面：宿主侧的选中一起清掉，免得之后刷新这个新页面时把旧页面的选择器推回去（!3548 第二轮 CR-01）
      // 兜底：换页时不管还有没有选中都解绑引用、复位一次性提示。正常路径到不了这里——退出点选的各条路径
      // （setMode、mode-changed、运行时卸下、pageKey 换页）都已先调 detachChips；这里只防将来改动漏掉（!3548 第七轮）
      if (!samePage) detachChips();
      if (!samePage && state.selections.length > 0) {
        latest.current.selections = [];
        setSelections([]);
        setWritable(null);
        setTextWritable(false);
        setSourceUnreadable(false);
      }
      if (!run) return;
      void run({ type: "set-mode", mode: state.mode });
      if (state.variant !== null) void run({ type: "set-variant", variant: state.variant });
      // 同一页面刷新（如 Agent 改了文件）后按选择器恢复选中；换了页面就清空
      // （运行时同版本复用时页面里可能还留着宿主已不认识的选中，比如浏览器视图重挂后，这里一并清掉）
      if (samePage && state.selections.length > 0) {
        void run({ type: "set-selection", selectors: state.selections.map(selectorOf) });
      } else {
        void run({ type: "set-selection", selectors: [] });
      }
    },
    [detachChips, resetChipQueue],
  );

  const handleSignals = useCallback((next: DesignPageSignals, url: string) => {
    setSignals({ pageKey: toDesignPageKey(url), signals: next });
  }, []);

  const { run } = useBrowserDesignRuntime({
    active: runtimeActive,
    onEvent: handleEvent,
    onInstalled: handleInstalled,
    onSignals: handleSignals,
    probeEnabled: probeEnabled && pluginEnabled,
    webview,
    webviewGeneration,
  });
  runRef.current = run;

  // 运行时卸下（离开设计稿且不在点选）时页面已由 dispose 还原，宿主侧的临时状态一起清掉
  useEffect(() => {
    if (runtimeActive) return;
    setModeState("off");
    setPanelOpen(false);
    setSelections([]);
    latest.current.selections = [];
    setVariablePreviewState({});
    setVariantState(null);
    setPageInfo(null);
    lastInstalledKeyRef.current = null;
    detachChips();
  }, [detachChips, runtimeActive]);

  const setMode = useCallback(
    (next: DesignInteractionMode) => {
      const target = latest.current.mode === next ? "off" : next;
      // 进点选时不开面板，选中元素后才出来（11-05 用户反馈：没选中时面板是空的，还挡画板）
      if (target !== "off") onSelectModeStart?.();
      setModeState(target);
      void run({ type: "set-mode", mode: target });
      if (target === "off") {
        // 退出点选 = 退出设计模式：面板一起收起（11-05 反馈）
        setPanelOpen(false);
        void run({ type: "set-selection", selectors: [] });
        detachChips();
      }
    },
    [detachChips, onSelectModeStart, run],
  );

  const requestSelectMode = useCallback(async () => {
    if (!isVisible || !probeEnabled || pendingSelection.current) return;
    if (latest.current.mode !== "off") {
      setMode("select");
      return;
    }
    const controller = new AbortController();
    pendingSelection.current = controller;
    try {
      await initializePlugin();
      if (controller.signal.aborted) return;
      const state = pluginStore.getState();
      if (!chipTarget || !rpcReady || state.error) {
        logger.warn("[browser-design] 无法读取 Design 插件状态", { rpcReady, error: state.error });
        toast(intl.formatMessage({ id: "browser.design.pluginCheckFailed" }), {
          variant: "warning",
        });
        return;
      }
      if (state.plugins.some((plugin) => plugin.id === DESIGN_PLUGIN_ID && plugin.enabled)) {
        setMode("select");
        return;
      }
      const confirmed = await confirm(
        {
          title: intl.formatMessage({ id: "browser.design.pluginRequired.title" }),
          description: intl.formatMessage({ id: "browser.design.pluginRequired.description" }),
          confirmLabel: intl.formatMessage({ id: "browser.design.pluginRequired.action" }),
          testId: "browser-design-plugin-required",
          showKeyboardHints: false,
        },
        controller.signal,
      );
      if (confirmed && !controller.signal.aborted) requestPluginStoreOpen(DESIGN_PLUGIN_ID);
    } finally {
      if (pendingSelection.current === controller) pendingSelection.current = null;
    }
  }, [
    chipTarget,
    confirm,
    initializePlugin,
    intl,
    isVisible,
    pluginStore,
    probeEnabled,
    rpcReady,
    setMode,
  ]);

  const stopSelecting = useCallback(() => {
    if (latest.current.mode !== "off") setMode("select");
  }, [setMode]);

  // 单页应用换路由（pushState、前进后退）不会重新注入运行时：地址一换也按换页处理，退出点选（!3548 第三轮）
  const lastPageKeyRef = useRef(pageKey);
  useEffect(() => {
    // 取地址失败时会短暂退回 about:blank（导航途中、guest 重附）：不当成换页，免得同一页面重附时误退出
    if (lastPageKeyRef.current === pageKey || pageKey.startsWith("about:")) return;
    lastPageKeyRef.current = pageKey;
    stopSelecting();
  }, [pageKey, stopSelecting]);

  const selectParent = useCallback(() => {
    void run({ type: "select-parent" });
  }, [run]);

  // ---- 面板改值：预览作用于全部选中元素；提交写回源文件 ----
  const previewStyle = useCallback(
    (property: DesignStyleProperty, value: string) => {
      for (const selection of latest.current.selections) {
        void run({
          type: "set-element-properties",
          selector: selectorOf(selection),
          styles: { [DESIGN_STYLE_CSS_NAMES[property]]: value },
        });
      }
    },
    [run],
  );
  /**
   * 面板里改文字（单选、源码里只含文字）。页面读回的文字会被截到 DESIGN_PAGE_LIMITS.longText，
   * 截到上限的不让改：写回会用截断的值替换整段，尾部丢掉（!3450 CR-03）。
   */
  const commitText = useCallback(
    async (text: string) => {
      const primary = latest.current.selections.at(-1);
      if (!primary || latest.current.selections.length !== 1) return;
      if ((primary.editable.text ?? "").length >= DESIGN_PAGE_LIMITS.longText) return;
      if (text === primary.editable.text) return;
      void runLatest({ type: "set-element-text", selector: selectorOf(primary), text });
      await commitElements([{ selection: primary, text }]);
    },
    [commitElements, runLatest],
  );
  const commitStyle = useCallback(
    async (property: DesignStyleProperty, value: string) => {
      const items = latest.current.selections;
      if (items.length === 0) return;
      previewStyle(property, value);
      await commitElements(
        items.map((selection) => ({
          selection,
          styles: { [DESIGN_STYLE_CSS_NAMES[property]]: value },
        })),
      );
    },
    [commitElements, previewStyle],
  );

  const tweakControls = useMemo(
    () => buildCssVariableTweakControls(pageInfo?.cssVariables ?? []),
    [pageInfo],
  );
  const previewVariable = useCallback(
    (name: string, value: string | number) => {
      const control = tweakControls.find((item) => item.id === name);
      if (control) setVariablePreview(name, formatTweakValue(control, value));
    },
    [setVariablePreview, tweakControls],
  );
  const commitVariableValue = useCallback(
    async (name: string, value: string | number) => {
      const control = tweakControls.find((item) => item.id === name);
      if (!control) return;
      const formatted = formatTweakValue(control, value);
      setVariablePreview(name, formatted);
      // 写回失败时 writer 按这次读到的源码撤回预览
      await commitVariable(name, formatted);
    },
    [commitVariable, setVariablePreview, tweakControls],
  );

  const setVariant = useCallback(
    (next: string | null) => {
      setVariantState(next);
      void run({ type: "set-variant", variant: next });
    },
    [run],
  );

  const goToSlide = useCallback(
    (index: number) => {
      if (index < 0 || index >= slide.count) return;
      setSlide((current) => ({ ...current, index }));
      void run({ type: "go-to-slide", index });
    },
    [run, slide.count],
  );

  return {
    toolsVisible,
    mode,
    requestSelectMode,
    stopSelecting,
    pageInfo,
    panelOpen,
    setPanelOpen,
    selections,
    /** 选中的元素都能写回源码；null 表示没选中或还在查 */
    writable,
    sourceUnreadable,
    /** 文字能在面板里改：单选、源码里只含文字、没被截断 */
    textWritable:
      textWritable && (selections.at(-1)?.editable.text ?? "").length < DESIGN_PAGE_LIMITS.longText,
    commitText,
    canWriteSource: writer.canWrite,
    /** 自动刷新问：这次主 HTML 变化是不是这个 tab 自己写的（只认本 tab 的写入） */
    isOwnSourceWrite: isOwnWrite,
    sourceFileName: writer.fileName,
    selectParent,
    previewStyle,
    commitStyle,
    tweakControls,
    variablePreview,
    previewVariable,
    commitVariable: commitVariableValue,
    undo,
    redo,
    variant,
    setVariant,
    slide,
    goToSlide,
  };
}

export type BrowserDesignModeController = ReturnType<typeof useBrowserDesignMode>;
