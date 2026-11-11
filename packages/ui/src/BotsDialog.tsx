/* eslint-disable max-lines -- BotsDialog 现在保留数据加载、保存和轮询编排；右侧卡片已拆到 BotsDialog/* 子组件，后续再继续下沉状态 hook。 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import QRCode from "qrcode";
import { Bot, LoaderCircle, Plus } from "lucide-react";
import type {
  BotConfig,
  BotProvider,
  BotServiceStatus,
  BotState,
  BotWorkspaceRef,
  BotsConfigFile,
} from "@zcode/shared";
import {
  ALL_BOT_WORKSPACES,
  createUuid,
  DEFAULT_BOT_REPLY_GRANULARITY,
  isFeishuBotProvider,
  normalizeBotReplyGranularity,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { logger } from "@/logger.js";
import {
  BOT_PROVIDERS,
  getBotProviderRegionTagLabelId,
  resolveBotProviderEntry,
  type BotProviderEntryId,
} from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";
import {
  BotDangerCard,
  BotReplyGranularityCard,
  BotSummaryCard,
} from "@/BotsDialog/BotSummaryCard.js";
import { ProviderSettingsCard } from "@/BotsDialog/ProviderSettingsCard.js";
import { BoundGroupsCard } from "@/BotsDialog/BoundGroupsCard.js";
import { WorkspaceAccessCard } from "@/BotsDialog/WorkspaceAccessCard.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  BIND_CODE_TTL_MS,
  ProviderIcon,
  TELEGRAM_BOTFATHER_URL,
  createDefaultCommands,
  formatBotDisplayName,
  isAllWorkspacesAllowed,
  runtimeDot,
  type BindCodeState,
  type FeishuRegistrationState,
  type WeixinRegistrationState,
} from "@/BotsDialog/shared.js";

function createEmptyConfig(): BotsConfigFile {
  return { version: 3, bots: [] };
}

function createDraftBot(params: { provider: BotProvider }): BotConfig {
  // Bugfix: Bot id 只是配置实体身份，不应该带 provider 前缀；
  // 新建时如果看到 telegram-* 这类 id，容易误以为渠道被固定到了 Telegram。
  const id = `bot-${createUuid()}`;
  return {
    id,
    name: "",
    provider: params.provider,
    enabled: true,
    allowedWorkspaces: [ALL_BOT_WORKSPACES],
    allowedCommands: createDefaultCommands(),
    currentOptions: {},
    replyMode: normalizeBotReplyGranularity(params.provider, DEFAULT_BOT_REPLY_GRANULARITY),
  };
}

export function BotsDialog({
  open,
  onOpenChange,
  entryProvider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryProvider?: BotProvider | null;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { botsService } = useServices();
  const [config, setConfig] = useState<BotsConfigFile>(() => createEmptyConfig());
  const [workspaceRefs, setWorkspaceRefs] = useState<BotWorkspaceRef[]>([]);
  const [status, setStatus] = useState<BotServiceStatus | null>(null);
  const [botStates, setBotStates] = useState<BotState[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState<BotProvider | null>(null);
  const [bindCode, setBindCode] = useState<BindCodeState | null>(null);
  const [feishuRegistration, setFeishuRegistration] = useState<FeishuRegistrationState | null>(
    null,
  );
  const [feishuRegistrationLoading, setFeishuRegistrationLoading] = useState(false);
  const [weixinRegistration, setWeixinRegistration] = useState<WeixinRegistrationState | null>(
    null,
  );
  const [weixinRegistrationLoading, setWeixinRegistrationLoading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [credentialValue, setCredentialValue] = useState("");
  const [secretSaving, setSecretSaving] = useState(false);
  const [workspaceAccessSaving, setWorkspaceAccessSaving] = useState(false);
  const [botNameDraft, setBotNameDraft] = useState<{
    botId: string;
    value: string;
  } | null>(null);
  const [renamingBotId, setRenamingBotId] = useState<string | null>(null);
  const botNameCompositionActiveRef = useRef(false);
  const autoQrStartedBotIdsRef = useRef(new Set<string>());
  const autoBindCreatingBotIdsRef = useRef(new Set<string>());
  const handledEntryProviderRef = useRef<BotProvider | null>(null);

  const selectedBot = config.bots.find((bot) => bot.id === selectedBotId) ?? null;
  const selectedBotState = botStates.find((state) => state.botId === selectedBotId) ?? null;
  const selectedBotName =
    selectedBot && botNameDraft?.botId === selectedBot.id
      ? botNameDraft.value
      : (selectedBot?.name ?? "");
  const fallbackBotName = intl.formatMessage({
    id: "bots.newBot.fallbackName",
  });
  const selectedBotDisplayName = formatBotDisplayName(selectedBotName, fallbackBotName);
  const bindRemainingMs = bindCode ? Math.max(0, bindCode.expiresAt - nowMs) : 0;
  const bindExpired = Boolean(bindCode && bindRemainingMs <= 0);
  const bindCountdownProgress = bindCode
    ? Math.max(0, Math.min(100, (bindRemainingMs / bindCode.ttlMs) * 100))
    : 0;

  useEffect(() => {
    if (!open || !bindCode) return undefined;
    setNowMs(Date.now());
    // Bugfix: 绑定码缩短到 30 秒后，1 秒刷新会让进度条明显跳格。
    // 这里用更细的节奏驱动动画，文字仍由 formatBindCountdown 按秒展示。
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [bindCode, open]);

  useEffect(() => {
    if (!open || !bindCode || bindExpired) return undefined;
    let cancelled = false;

    const pollBindResult = async () => {
      try {
        const nextConfig = await botsService.getConfig();
        if (cancelled) return;
        setConfig(nextConfig);
        const targetBot = nextConfig.bots.find((bot) => bot.id === bindCode.botId);
        if (targetBot?.providerUserId) {
          // Bugfix: /bind 是从第三方聊天回写配置，UI 没有直接事件。
          // 绑定码展开期间低频刷新配置，绑定成功后立即收起绑定区域。
          setBindCode(null);
        }
      } catch (error) {
        logger.warn(
          "[BotsDialog] 轮询 Bot 绑定结果失败",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    void pollBindResult();
    const timer = window.setInterval(() => {
      void pollBindResult();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bindCode, bindExpired, botsService, open]);

  useEffect(() => {
    if (!bindCode || bindCode.botId !== selectedBot?.id || !selectedBot.providerUserId) {
      return;
    }
    // Bugfix: /bind 成功是服务层异步回写配置；即使轮询刚好被切换/刷新打断，
    // 只要当前 Bot 已经带 providerUserId，就应该立即收起旧绑定码。
    setBindCode(null);
  }, [bindCode, selectedBot?.id, selectedBot?.providerUserId]);

  useEffect(() => {
    setCredentialValue("");
    setSecretSaving(false);
    setWorkspaceAccessSaving(false);
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  }, [selectedBotId, selectedBot?.provider]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollStatus = async () => {
      try {
        const nextStatus = await botsService.getStatus();
        if (!cancelled) setStatus(nextStatus);
      } catch (error) {
        logger.debug("[BotsDialog] 刷新 Bot 运行状态失败", error);
      } finally {
        // 投递在后台完成；只在弹窗可见时串行刷新，避免慢 RPC 堆积或关闭后回写。
        if (!cancelled) timer = setTimeout(() => void pollStatus(), 2000);
      }
    };
    void pollStatus();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [botsService, open]);

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextStatus, nextWorkspaces, nextBotStates] = await Promise.all([
        botsService.getConfig(),
        botsService.getStatus(),
        botsService.listWorkspaceRefs(),
        botsService.getBotStates(),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setWorkspaceRefs(nextWorkspaces);
      setBotStates(nextBotStates);
      setConfigLoaded(true);
      setSelectedBotId((current) =>
        creatingBot ? current : (current ?? nextConfig.bots[0]?.id ?? null),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 加载 Bots 配置失败", message);
      toast(intl.formatMessage({ id: "bots.loadFailed" }, { error: message }));
    }
  }, [botsService, creatingBot, intl]);

  useEffect(() => {
    if (
      !open ||
      selectedBot?.provider !== "weixin" ||
      !selectedBot.credentialRef ||
      selectedBotState?.weixinActivatedAt
    ) {
      return undefined;
    }
    let cancelled = false;
    const pollActivationState = async () => {
      try {
        const nextBotStates = await botsService.getBotStates();
        if (!cancelled) {
          setBotStates(nextBotStates);
        }
      } catch (error) {
        logger.warn(
          "[BotsDialog] 轮询微信 Bot 激活状态失败",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    const timer = window.setInterval(() => {
      void pollActivationState();
    }, 2000);
    void pollActivationState();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    botsService,
    open,
    selectedBot?.credentialRef,
    selectedBot?.id,
    selectedBot?.provider,
    selectedBotState?.weixinActivatedAt,
  ]);

  useEffect(() => {
    if (open) {
      setConfigLoaded(false);
      void refresh();
    }
  }, [open, refresh]);

  useEffect(() => {
    handledEntryProviderRef.current = null;
  }, [entryProvider, open]);

  const saveBot = useCallback(
    async (bot: BotConfig, secrets?: { credentialValue?: string }) => {
      const saved = await botsService.saveBot({
        bot,
        credentialValue: secrets?.credentialValue,
      });
      setConfig((previous) => ({
        ...previous,
        bots: [...previous.bots.filter((item) => item.id !== saved.id), saved],
      }));
      setSelectedBotId(saved.id);
      setCreatingBot(false);
      setCredentialValue("");
      void refresh();
      return saved;
    },
    [botsService, refresh],
  );

  const createBindCodeForBot = useCallback(
    async (bot: BotConfig) => {
      const createdAt = Date.now();
      const result = await botsService.createBindCode({
        botId: bot.id,
        ttlMs: BIND_CODE_TTL_MS,
        allowedWorkspaces: bot.allowedWorkspaces,
      });
      setNowMs(createdAt);
      setBindCode({
        botId: bot.id,
        code: result.code,
        createdAt,
        expiresAt: result.expiresAt,
        ttlMs: Math.max(1, result.expiresAt - createdAt),
      });
    },
    [botsService],
  );

  useEffect(() => {
    const registration = feishuRegistration;
    if (!open || !selectedBot || !isFeishuBotProvider(selectedBot.provider) || !registration) {
      return undefined;
    }
    if (registration.status !== "pending") {
      return undefined;
    }

    let cancelled = false;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    const pollRegistration = async () => {
      try {
        const result = await botsService.pollFeishuRegistration({
          deviceCode: registration.deviceCode,
          domain: registration.domain,
          pollDomain: registration.pollDomain,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending") {
          setFeishuRegistration((current) => {
            if (current?.deviceCode !== registration.deviceCode) {
              return current;
            }
            if (
              current.interval === result.interval &&
              current.domain === result.domain &&
              current.pollDomain === result.pollDomain
            ) {
              return current;
            }
            // Bugfix: pending 轮询结果通常不变；如果每次都创建新对象，会触发 effect 依赖变化，
            // 进而立即重启轮询并造成毫秒级 RPC 风暴。
            return {
              ...current,
              interval: result.interval,
              domain: result.domain,
              pollDomain: result.pollDomain,
            };
          });
          return;
        }
        if (result.status === "success") {
          // Bugfix: 服务层一直支持飞书扫码注册，但 Bots 重构后的 UI 只保留了手填凭据。
          // 扫码成功后直接复用 saveBot 的 secret 写入路径，避免把 App Secret 留在明文配置文件里。
          const savedBot = await saveBot(
            {
              ...selectedBot,
              provider: selectedBot.provider,
              name: result.appName?.trim() || selectedBot.name,
              feishuAppId: result.appId,
            },
            { credentialValue: result.appSecret },
          );
          if (!cancelled) {
            // Bugfix: 飞书/Lark 扫码成功只完成应用凭据接入；绑定码由“有凭据但未绑定”的统一状态机生成。
            // 这里仅收起二维码，避免二维码和 /bind 面板在一次状态更新里互相抢展示优先级。
            setConfig((previous) => ({
              ...previous,
              bots: previous.bots.map((bot) => (bot.id === savedBot.id ? savedBot : bot)),
            }));
            setFeishuRegistration(null);
            toast(intl.formatMessage({ id: "bots.feishuRegistrationSuccess" }));
          }
          return;
        }
        setFeishuRegistration((current) =>
          current?.deviceCode === registration.deviceCode
            ? {
                ...current,
                status: result.status,
                message:
                  result.message ??
                  intl.formatMessage({
                    id: `bots.feishuRegistration.${result.status}`,
                  }),
              }
            : current,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 飞书扫码注册轮询失败", message);
        if (!cancelled) {
          setFeishuRegistration((current) =>
            current?.deviceCode === registration.deviceCode
              ? { ...current, status: "error", message }
              : current,
          );
        }
      }
    };

    const timer = window.setInterval(() => {
      void pollRegistration();
    }, pollIntervalMs);
    void pollRegistration();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [botsService, createBindCodeForBot, feishuRegistration, intl, open, saveBot, selectedBot]);

  useEffect(() => {
    const registration = weixinRegistration;
    if (!open || !selectedBot || selectedBot.provider !== "weixin" || !registration) {
      return undefined;
    }
    if (registration.status !== "pending" && registration.status !== "scanned") {
      return undefined;
    }

    let cancelled = false;
    let timer: number | undefined;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    const scheduleNextPoll = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(() => {
        void runPoll();
      }, pollIntervalMs);
    };

    const pollRegistration = async () => {
      try {
        const result = await botsService.pollWeixinRegistration({
          qrCode: registration.qrCode,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending" || result.status === "scanned") {
          setWeixinRegistration((current) => {
            if (current?.qrCode !== registration.qrCode) {
              return current;
            }
            if (current.interval === result.interval && current.status === result.status) {
              return current;
            }
            return {
              ...current,
              interval: result.interval,
              status: result.status,
            };
          });
          return;
        }
        if (result.status === "success") {
          await saveBot(
            {
              ...selectedBot,
              webhookUrl: undefined,
              providerUserId: result.botId ?? selectedBot.providerUserId,
              displayName: result.botId ?? selectedBot.displayName,
              name: selectedBot.name,
            },
            { credentialValue: result.botToken },
          );
          if (!cancelled) {
            // Bugfix: 微信扫码成功即完成连接，保留 QR registration 会让用户看到过期的扫码区域。
            // 清掉临时状态后，Bot token 行会切到已连通的 Unbind 操作。
            setWeixinRegistration(null);
            toast(intl.formatMessage({ id: "bots.weixinRegistrationSuccess" }));
          }
          cancelled = true;
          return;
        }
        setWeixinRegistration((current) =>
          current?.qrCode === registration.qrCode
            ? {
                ...current,
                status: result.status,
                message:
                  ("message" in result ? result.message : undefined) ??
                  intl.formatMessage({
                    id: `bots.weixinRegistration.${result.status}`,
                  }),
              }
            : current,
        );
        cancelled = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 微信扫码登录轮询失败", message);
      }
    };

    const runPoll = async () => {
      await pollRegistration();
      scheduleNextPoll();
    };

    // Bugfix: 微信扫码状态接口会长等待，如果用 setInterval 会在上一次请求未返回时继续堆叠 RPC。
    // 串行轮询可以避免连续 timeout，也避免多个结果互相覆盖 UI 状态。
    void runPoll();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [botsService, intl, open, saveBot, selectedBot, weixinRegistration]);

  const patchSelectedBot = useCallback(
    (patch: Partial<BotConfig>) => {
      if (!selectedBot) return;
      void saveBot({ ...selectedBot, ...patch });
    },
    [saveBot, selectedBot],
  );

  const startBotNameRename = useCallback(() => {
    if (!selectedBot) return;
    setRenamingBotId(selectedBot.id);
    setBotNameDraft({ botId: selectedBot.id, value: selectedBot.name });
  }, [selectedBot]);

  const commitBotNameDraft = useCallback(() => {
    if (!selectedBot) return;
    const nextName = selectedBotName.trim();
    setBotNameDraft(null);
    setRenamingBotId(null);
    if (nextName === selectedBot.name) return;
    // Bugfix: Bot 名称输入过程中如果立即保存，服务层 trim 后的回写会吃掉刚输入的尾部空格，
    // 导致用户无法继续输入包含空格的名称；改为提交时保存，保留输入过程中的本地草稿。
    // 同时空名称是合法的未命名状态，展示层统一用多语言 fallback 名称兜底。
    void saveBot({ ...selectedBot, name: nextName });
  }, [saveBot, selectedBot, selectedBotName]);

  const handleBotNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (
          isImeComposingKeyEvent({
            compositionActive: botNameCompositionActiveRef.current,
            nativeEvent: event.nativeEvent,
          })
        ) {
          // Bugfix: Bot 名称重命名时中文输入法 Enter 是候选词确认，不是提交重命名。
          // 这里避免触发 blur，否则 blur 会继续走 commitBotNameDraft。
          logger.debug("[BotsDialog] ignore bot name enter during IME", {
            botId: selectedBot?.id ?? null,
          });
          return;
        }
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        // Bugfix: 重命名输入框里的 Escape 只应该取消编辑，不能继续冒泡触发 Dialog 的关闭快捷键。
        setBotNameDraft(null);
        setRenamingBotId(null);
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [selectedBot?.id],
  );

  const handleDialogEscapeKeyDown = useCallback(
    (event: Event) => {
      if (renamingBotId === null) return;
      // Bugfix: Radix Dialog 会在输入框 React onKeyDown 冒泡前处理 Escape 关闭。
      // 正在重命名时需要在 Dialog 的关闭入口拦截，Esc 只取消编辑，不关闭弹窗。
      event.preventDefault();
      setBotNameDraft(null);
      setRenamingBotId(null);
    },
    [renamingBotId],
  );

  const patchAllowedWorkspaces = useCallback(
    async (allowedWorkspaces: string[]) => {
      if (!selectedBot) return;
      setWorkspaceAccessSaving(true);
      const normalizedAllowedWorkspaces =
        allowedWorkspaces.length > 0 ? allowedWorkspaces : [ALL_BOT_WORKSPACES];
      const previousBot = selectedBot;
      const optimisticBot = {
        ...selectedBot,
        allowedWorkspaces: normalizedAllowedWorkspaces,
      };
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((bot) => (bot.id === optimisticBot.id ? optimisticBot : bot)),
      }));
      try {
        await saveBot(optimisticBot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 保存工作区访问范围失败", message);
        setConfig((previous) => ({
          ...previous,
          bots: previous.bots.map((bot) => (bot.id === previousBot.id ? previousBot : bot)),
        }));
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      } finally {
        setWorkspaceAccessSaving(false);
      }
    },
    [intl, saveBot, selectedBot],
  );

  const toggleWorkspaceAccess = useCallback(
    async (workspaceId: string, checked: boolean) => {
      if (!selectedBot) return;
      const currentAllowed = isAllWorkspacesAllowed(selectedBot.allowedWorkspaces)
        ? workspaceRefs.map((workspace) => workspace.id)
        : selectedBot.allowedWorkspaces;
      const nextAllowed = checked
        ? [...new Set([...currentAllowed, workspaceId])]
        : currentAllowed.filter((id) => id !== workspaceId);
      await patchAllowedWorkspaces(nextAllowed);
    },
    [patchAllowedWorkspaces, selectedBot, workspaceRefs],
  );

  const handleBeginAddBot = () => {
    setCreatingBot(true);
    setCreatingProvider(null);
    setSelectedBotId(null);
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  };

  const handleAddBot = useCallback(
    async (provider: BotProvider) => {
      if (creatingProvider) return;
      setCreatingProvider(provider);
      const bot = createDraftBot({
        provider,
      });
      try {
        await saveBot({
          ...bot,
          name: "",
          ...(provider === "webhook" ? { webhookAuthHeaderName: "x-zcode-bot-secret" } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 创建 Bot 失败", message);
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      } finally {
        setCreatingProvider(null);
      }
    },
    [creatingProvider, intl, saveBot],
  );

  useEffect(() => {
    if (!open || !entryProvider || !configLoaded) {
      return;
    }
    if (handledEntryProviderRef.current === entryProvider) {
      return;
    }

    const entry = resolveBotProviderEntry(config.bots, entryProvider);
    handledEntryProviderRef.current = entryProvider;
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);

    if (entry.mode === "select") {
      setCreatingBot(false);
      setCreatingProvider(null);
      setSelectedBotId(entry.botId);
      return;
    }

    // Bugfix: 远程控制弹窗新增 Bot Channel 快捷入口后，进入 BotsDialog 不能停在空白选择页。
    // 这里在配置加载完成后再判断并创建，避免异步刷新尚未拿到已有 bot 时重复新建。
    setCreatingBot(true);
    setSelectedBotId(null);
    void handleAddBot(entry.provider);
  }, [config.bots, configLoaded, entryProvider, handleAddBot, open]);

  const handleCreateBindCode = async () => {
    if (!selectedBot) return;
    await createBindCodeForBot(selectedBot);
  };

  const handleSaveSecret = async () => {
    if (!selectedBot || secretSaving) return;
    setSecretSaving(true);
    try {
      await saveBot(selectedBot, { credentialValue });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 保存 Bot secret 失败", message);
      toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
    } finally {
      setSecretSaving(false);
    }
  };

  const handleStartFeishuRegistration = useCallback(async () => {
    if (!selectedBot || !isFeishuBotProvider(selectedBot.provider)) return;
    setFeishuRegistrationLoading(true);
    try {
      const result = await botsService.beginFeishuRegistration({
        domain: selectedBot.provider,
      });
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] 生成飞书注册二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      setFeishuRegistration({
        botId: selectedBot.id,
        deviceCode: result.deviceCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        userCode: result.userCode,
        interval: result.interval,
        expiresAt: result.expiresAt,
        domain: result.domain,
        pollDomain: result.pollDomain,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.feishuRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 启动飞书扫码注册失败", message);
      toast(intl.formatMessage({ id: "bots.feishuRegistrationFailed" }, { error: message }));
    } finally {
      setFeishuRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  const handleStartWeixinRegistration = useCallback(async () => {
    if (!selectedBot || selectedBot.provider !== "weixin") return;
    setWeixinRegistrationLoading(true);
    try {
      const result = await botsService.beginWeixinRegistration();
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] 生成微信登录二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      setWeixinRegistration({
        botId: selectedBot.id,
        qrCode: result.qrCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        interval: result.interval,
        expiresAt: result.expiresAt,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.weixinRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 启动微信扫码登录失败", message);
      toast(intl.formatMessage({ id: "bots.weixinRegistrationFailed" }, { error: message }));
    } finally {
      setWeixinRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  useEffect(() => {
    if (!open || creatingBot || !selectedBot) {
      return;
    }

    if (isFeishuBotProvider(selectedBot.provider)) {
      if (!selectedBot.credentialRef) {
        if (feishuRegistrationLoading) {
          return;
        }
        if (feishuRegistration?.botId === selectedBot.id) {
          return;
        }

        const autoKey = `${selectedBot.id}:feishu-registration`;
        if (autoQrStartedBotIdsRef.current.has(autoKey)) {
          return;
        }

        // Bugfix: 未配置 token 的飞书/Lark Bot 首次进入详情时只显示“扫码”按钮，
        // 用户会误以为还需要额外展开；自动启动一次二维码流程，让缺失凭据的默认状态直接可操作。
        autoQrStartedBotIdsRef.current.add(autoKey);
        void handleStartFeishuRegistration();
        return;
      }

      if (!selectedBot.providerUserId) {
        if (bindCode?.botId === selectedBot.id && !bindExpired) {
          return;
        }
        if (autoBindCreatingBotIdsRef.current.has(selectedBot.id)) {
          return;
        }

        // Bugfix: 飞书/Lark 的接入凭据和聊天绑定是两个阶段；已有凭据但未绑定时需要自动展示 /bind。
        // 绑定码现在只有 30 秒有效期，过期后如果还停在旧码会打断自动绑定流程；这里自动续一枚新码。
        autoBindCreatingBotIdsRef.current.add(selectedBot.id);
        void createBindCodeForBot(selectedBot).finally(() => {
          autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
        });
      }
      return;
    }

    if (selectedBot.provider === "telegram") {
      if (!selectedBot.credentialRef || selectedBot.providerUserId) {
        return;
      }
      if (bindCode?.botId === selectedBot.id && !bindExpired) {
        return;
      }
      if (autoBindCreatingBotIdsRef.current.has(selectedBot.id)) {
        return;
      }

      // Bugfix: Telegram 和飞书/Lark 一样分成凭据接入与私聊绑定两步；
      // token 保存后自动展示 /bind；绑定码过期也自动续码，避免 30 秒有效期让用户卡在旧码上。
      autoBindCreatingBotIdsRef.current.add(selectedBot.id);
      void createBindCodeForBot(selectedBot).finally(() => {
        autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      });
      return;
    }

    if (selectedBot.provider !== "weixin") {
      return;
    }
    if (selectedBot.credentialRef || weixinRegistrationLoading) {
      return;
    }
    if (weixinRegistration?.botId === selectedBot.id) {
      return;
    }

    const autoKey = `${selectedBot.id}:weixin-registration`;
    if (autoQrStartedBotIdsRef.current.has(autoKey)) {
      return;
    }

    // Bugfix: 微信 Bot 没有 token/绑定状态时需要立即给出登录二维码，
    // 否则新建后右侧默认只露出按钮，和“扫码接入”的主流程不一致。
    autoQrStartedBotIdsRef.current.add(autoKey);
    void handleStartWeixinRegistration();
  }, [
    creatingBot,
    feishuRegistration,
    feishuRegistrationLoading,
    bindCode,
    bindExpired,
    createBindCodeForBot,
    handleStartFeishuRegistration,
    handleStartWeixinRegistration,
    open,
    selectedBot,
    weixinRegistration,
    weixinRegistrationLoading,
  ]);

  const handleOpenTelegramBotFather = () => {
    platform.openExternal(TELEGRAM_BOTFATHER_URL);
  };

  const copyBindCommand = async () => {
    if (!bindCode || bindExpired) return;
    const command = `/bind ${bindCode.code}`;
    await navigator.clipboard?.writeText(command).catch((error: unknown) => {
      logger.warn(
        "[BotsDialog] 复制绑定命令失败",
        error instanceof Error ? error.message : String(error),
      );
    });
    toast(intl.formatMessage({ id: "bots.bindCommandCopied" }));
  };

  const handleUnbind = async () => {
    if (!selectedBot) return;
    await saveBot({
      ...selectedBot,
      providerUserId: undefined,
      displayName: undefined,
    });
    await botsService.resetBotState(selectedBot.id);
  };

  const handleRemoveSecret = async () => {
    if (!selectedBot) return;
    try {
      const saved = await botsService.removeBotSecret(selectedBot.id);
      autoQrStartedBotIdsRef.current.delete(`${selectedBot.id}:feishu-registration`);
      autoQrStartedBotIdsRef.current.delete(`${selectedBot.id}:weixin-registration`);
      autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((item) => (item.id === saved.id ? saved : item)),
      }));
      setCredentialValue("");
      setBindCode(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 移除 Bot secret 失败", message);
      toast(intl.formatMessage({ id: "bots.removeSecretFailed" }, { error: message }));
    }
  };

  const handleDelete = async () => {
    if (!selectedBot) return;
    // Bugfix: 删除机器人之前没有二次确认，误触会直接移除凭据和绑定入口。
    // 这里复用项目统一 ConfirmDialog，让破坏性操作和其它设置页保持一致。
    const confirmed = await confirmDialog({
      confirmVariant: "destructive",
      title: intl.formatMessage(
        { id: "bots.deleteConfirmTitle" },
        { name: formatBotDisplayName(selectedBot.name, fallbackBotName) },
      ),
      description: intl.formatMessage({ id: "bots.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "bots.delete" }),
    });
    if (!confirmed) return;

    try {
      await botsService.deleteBot(selectedBot.id);
      setSelectedBotId(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 删除 Bot 失败", message);
      toast(intl.formatMessage({ id: "bots.deleteFailed" }, { error: message }));
    }
  };

  const selectedRuntime = selectedBot
    ? status?.botRuntime.find((item) => item.botId === selectedBot.id)
    : undefined;
  const formatChannelName = (provider: BotProviderEntryId) =>
    intl.formatMessage({ id: `bots.channel.${provider}` });
  const renderChannelName = (provider: BotProviderEntryId) => {
    const regionTagLabelId = getBotProviderRegionTagLabelId(provider);

    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate">{formatChannelName(provider)}</span>
        {regionTagLabelId ? (
          <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
            {intl.formatMessage({ id: regionTagLabelId })}
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-6rem)] max-h-168 max-w-4xl flex-col overflow-hidden rounded-2xl"
        onEscapeKeyDown={handleDialogEscapeKeyDown}
      >
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="size-5 text-foreground" />
            <DialogTitle className="text-ui-lg font-medium text-foreground">
              {intl.formatMessage({ id: "bots.title" })}
            </DialogTitle>
            <DialogDescription className="ml-3">
              {intl.formatMessage({ id: "bots.description" })}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <aside className="flex max-h-40 w-full shrink-0 flex-col md:max-h-none md:w-64">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={handleBeginAddBot}
                className="mb-3 w-full justify-start gap-2 rounded-xl"
              >
                <Plus className="size-4" />
                <span className="min-w-0 truncate">
                  {intl.formatMessage({ id: "bots.addBot" })}
                </span>
              </Button>
              {config.bots.length === 0 ? (
                <div className="p-4 text-ui-base text-foreground-subtle">
                  {creatingBot
                    ? intl.formatMessage({
                        id: "bots.newBot.selectProviderHint",
                      })
                    : intl.formatMessage({ id: "bots.empty" })}
                </div>
              ) : (
                config.bots.map((bot) => {
                  const runtime = status?.botRuntime.find((item) => item.botId === bot.id);
                  const selected = bot.id === selectedBotId;
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => {
                        setCreatingBot(false);
                        setSelectedBotId(bot.id);
                      }}
                      className={cn(
                        "mb-1 w-full rounded-xl px-2.5 pr-4 py-3 text-left transition-colors",
                        selected
                          ? "bg-surface-hover text-foreground"
                          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <ProviderIcon
                          provider={bot.provider}
                          className="size-10 shrink-0 object-contain text-foreground-subtle"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-foreground truncate text-ui-base font-medium">
                            {formatBotDisplayName(bot.name, fallbackBotName)}
                          </span>
                          <span className="mt-0.5 flex min-w-0 text-ui-base text-foreground-subtle">
                            {renderChannelName(bot.provider)}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            runtimeDot(runtime, bot.enabled),
                          )}
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-background p-4">
            {creatingBot ? (
              <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-start gap-6">
                <div className="space-y-2">
                  <div className="text-ui-lg font-medium">
                    {intl.formatMessage({ id: "bots.newBot.title" })}
                  </div>
                  <p className="max-w-2xl text-ui-base leading-6 text-foreground-subtle">
                    {intl.formatMessage({ id: "bots.newBot.description" })}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {BOT_PROVIDERS.filter((provider) => provider.id !== "webhook").map((provider) => {
                    const implemented = provider.implemented;
                    const isCreatingThisProvider = creatingProvider === provider.id;
                    const isCreatingAnyProvider = creatingProvider !== null;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        disabled={!implemented || isCreatingAnyProvider}
                        aria-busy={isCreatingThisProvider}
                        onClick={() => (implemented ? void handleAddBot(provider.id) : undefined)}
                        className={cn(
                          "flex items-start gap-3 rounded-lg border border-card-border bg-card py-4 px-3 text-left transition-colors",
                          implemented && !isCreatingAnyProvider
                            ? "hover:border-input-border-focused hover:bg-surface-hover"
                            : "cursor-not-allowed opacity-60",
                          isCreatingThisProvider &&
                            "border-input-border-focused bg-surface-hover opacity-100",
                        )}
                      >
                        {isCreatingThisProvider ? (
                          <div className="flex size-10 items-center justify-center">
                            <LoaderCircle className="size-6 shrink-0 animate-spin text-foreground-subtle" />
                          </div>
                        ) : (
                          <ProviderIcon
                            provider={provider.id}
                            className="size-10 shrink-0 text-foreground"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 text-ui-lg font-medium">
                            {renderChannelName(provider.id)}
                          </span>
                          <span className="mt-1 block text-ui-base text-foreground-subtle">
                            {implemented
                              ? intl.formatMessage({
                                  id: `bots.newBot.providerDescription.${provider.id}`,
                                })
                              : intl.formatMessage({
                                  id: "bots.newBot.comingSoon",
                                })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : !selectedBot ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-ui-base text-foreground-subtle">
                <Bot className="size-8" />
                <div>{intl.formatMessage({ id: "bots.empty" })}</div>
                <Button variant="outline" size="lg" onClick={handleBeginAddBot}>
                  <Plus className="size-4" />
                  {intl.formatMessage({ id: "bots.addBot" })}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <BotSummaryCard
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  selectedBotDisplayName={selectedBotDisplayName}
                  selectedBotName={selectedBotName}
                  fallbackBotName={fallbackBotName}
                  renaming={renamingBotId === selectedBot.id}
                  onStartRename={startBotNameRename}
                  onCommitNameDraft={commitBotNameDraft}
                  onNameDraftChange={(value) => setBotNameDraft({ botId: selectedBot.id, value })}
                  onNameCompositionEnd={() => {
                    botNameCompositionActiveRef.current = false;
                  }}
                  onNameCompositionStart={() => {
                    botNameCompositionActiveRef.current = true;
                  }}
                  onNameInputKeyDown={handleBotNameKeyDown}
                  onPatchBot={patchSelectedBot}
                />

                <ProviderSettingsCard
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  credentialValue={credentialValue}
                  bindCode={bindCode}
                  bindExpired={bindExpired}
                  bindRemainingMs={bindRemainingMs}
                  bindCountdownProgress={bindCountdownProgress}
                  feishuRegistration={feishuRegistration}
                  feishuRegistrationLoading={feishuRegistrationLoading}
                  weixinRegistration={weixinRegistration}
                  weixinRegistrationLoading={weixinRegistrationLoading}
                  weixinActivated={Boolean(selectedBotState?.weixinActivatedAt)}
                  secretSaving={secretSaving}
                  onCredentialValueChange={setCredentialValue}
                  onSaveSecret={() => void handleSaveSecret()}
                  onRemoveSecret={() => void handleRemoveSecret()}
                  onOpenTelegramBotFather={handleOpenTelegramBotFather}
                  onStartWeixinRegistration={() => void handleStartWeixinRegistration()}
                  onStartFeishuRegistration={() => void handleStartFeishuRegistration()}
                  onCreateBindCode={() => void handleCreateBindCode()}
                  onUnbind={() => void handleUnbind()}
                  onCopyBindCommand={() => void copyBindCommand()}
                />

                <SettingsGroupCard>
                  <BotReplyGranularityCard bot={selectedBot} onPatchBot={patchSelectedBot} />

                  {/*
                    暂不暴露命令权限编辑入口，避免用户在 bot 可用前把关键命令关掉。
                    如果要恢复 UI，重新渲染 selectedBot.allowedCommands 的列表并用 patchSelectedBot 保存。
                  */}

                  <WorkspaceAccessCard
                    bot={selectedBot}
                    workspaceRefs={workspaceRefs}
                    loading={workspaceAccessSaving}
                    onPatchAllowedWorkspaces={patchAllowedWorkspaces}
                    onToggleWorkspaceAccess={toggleWorkspaceAccess}
                  />
                </SettingsGroupCard>

                {isFeishuBotProvider(selectedBot.provider) && (
                  <BoundGroupsCard
                    key={selectedBot.id + ":" + selectedBot.providerUserId}
                    bot={selectedBot}
                  />
                )}

                <BotDangerCard onDelete={() => void handleDelete()} />
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
