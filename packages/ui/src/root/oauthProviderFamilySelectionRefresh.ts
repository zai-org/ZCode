import type { IServiceAccessor } from "@zcode/services";
import type { AccountProviderState } from "@zcode/provider";
import type {
  AppSettings,
  OAuthAccountAvailability,
  OAuthProviderId,
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { getModelProviderFamilySpec, resolveStartPlanFamilyFromOAuthProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import {
  type ModelProviderFamilyConnectionSelection,
  resolveAutomaticModelProviderFamilyConnectionSelection,
} from "@/lib/modelProviderFamilyConnectionSelection.js";

import { getEnterprisePricingProductsOrEmpty } from "@/root/oauthTeamPricing.js";

/**
 * 纠正当前账号用不了的 providerFamilyDomain，返回纠正后的设置；无需纠正时原样返回。
 *
 * Bug 原因：未登录时 API Key 页“跳过”会写入所选 domain（如 zai），之后用国内入口（zai_cn）
 * 登录，登录完成和启动恢复都原样沿用这个账号用不了的值。账号的 Start 与个人／团队套餐因此
 * 都不是当前执行连接，升级入口按 zai 打开 Z.ai 购买页，官网对 zai_cn 登录固定显示
 * “等待 App 的登录信息”。退出会清空 domain，所以用户重登后才恢复。
 * 修复：账号可用 family（关联材料 + 登录渠道的 Start 家族）不包含当前 domain、且该 domain
 * 下没有保存过连接选择时，视为登录前遗留值，改为账号自己的 family。只按本地会话快照判断，
 * 不依赖网络；写入沿用设置 CAS，且不清空为 null，避免已登录用户被登录入口守卫送回登录页。
 */
async function correctUnusableProviderFamilyDomain(
  services: IServiceAccessor,
  settings: AppSettings,
  availability: OAuthAccountAvailability,
): Promise<AppSettings> {
  const current = settings.providerFamilyDomain;
  if (!current || !availability.loginProvider) return settings;
  const startFamily = resolveStartPlanFamilyFromOAuthProvider(availability.loginProvider);
  if (availability.families.includes(current) || current === startFamily) return settings;
  // 该 domain 下已有保存的选择是用户明确意图（如所选关联套餐的关联已失效），按 spec 只提示、
  // 不自动切换。自动退出不清空 domain，所以登录完成时也不能把它当作登录前遗留值。
  if (settings.providerFamilyConnectionSelections?.[current]) return settings;
  const next = availability.families[0] ?? startFamily;
  if (!next) return settings;
  try {
    await services.settingService.update(
      {
        providerFamilyDomain: next,
        providerFamilyDomainUpdatedAt: Date.now(),
        providerFamilyDomainMigrated: true,
      },
      {
        providerFamilyDomain: current,
        providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections,
        providerFamilyDomainUpdatedAt: settings.providerFamilyDomainUpdatedAt ?? 0,
      },
    );
  } catch (error) {
    // CAS 冲突表示另一写入方（用户切换、退出）已先改了设置；不覆盖它，后续按最新设置继续。
    logger.warn("[Root] 纠正 provider family 时设置已变化，按最新设置继续", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return services.settingService.get();
  }
  logger.info("[Root] 已纠正当前账号不可用的 provider family", {
    loginProvider: availability.loginProvider,
    from: current,
    to: next,
  });
  return services.settingService.get();
}

async function getUsageEntitlementSnapshotOrNull(params: {
  services: IServiceAccessor;
  providerId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}): Promise<UsageEntitlementSnapshot | null> {
  try {
    return await params.services.usageStatsService.getEntitlementSnapshot({
      includeSubscription: true,
      preferredProviderId: params.providerId,
      accountAccess: params.accountAccess,
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
  } catch (error) {
    logger.warn("[Root] 刷新登录后权益快照失败", {
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

async function refreshAccountProviderAccesses(params: {
  services: IServiceAccessor;
  providerIds: readonly string[];
  reason: string;
}): Promise<{
  accesses: ReadonlyMap<string, ZCodeProviderAccountAccess | ZCodeAccountAccess>;
  states: ReadonlyMap<string, AccountProviderState>;
  refreshed: boolean;
  error?: unknown;
}> {
  const providerSettingsService = params.services.providerSettingsService;

  try {
    const view = await providerSettingsService.refresh(params.reason);
    const accesses = new Map(
      params.providerIds.flatMap((providerId) => {
        const resolved = resolveAccountProviderInspectionAccess(view, providerId);
        if (!resolved) return [];
        const access = resolved.access;
        // 登录/启动检查属于套餐只读查询。静态 mode 会经执行期 current 解析，
        // 把未选中或 pending 的 Start 当作当前 Coding 查询；此处必须明确查询套餐自身。
        const query: ZCodeProviderAccountAccess | ZCodeAccountAccess =
          access.mode === "start-plan" || access.mode === "individual-coding-plan"
            ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
            : access;
        return [[providerId, query] as const];
      }),
    );
    return {
      refreshed: true,
      accesses,
      states: new Map(
        view.providers.flatMap((provider) =>
          provider.accountState ? [[provider.providerId, provider.accountState] as const] : [],
        ),
      ),
    };
  } catch (error) {
    logger.warn("[Root] 刷新 Account Provider 访问身份失败", {
      providerIds: params.providerIds,
      error,
    });
    return { refreshed: false, accesses: new Map(), states: new Map(), error };
  }
}

export async function refreshLatestModelProviderFamilySelectionAfterLogin(params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  const availability = await params.services.oauthService.getAccountAvailability();
  const currentSettings = await correctUnusableProviderFamilyDomain(
    params.services,
    await params.services.settingService.get(),
    availability,
  );
  const domain = currentSettings.providerFamilyDomain ?? availability.families[0] ?? null;
  if (!domain) return null;
  const saved = currentSettings.providerFamilyConnectionSelections?.[domain];
  // 已保存的选择代表用户意图；关联丢失也不能自动切到另一个套餐。
  if (saved) {
    // 退出保留各家族选择但清除当前家族；重登仅恢复可用家族，不覆盖原选择。
    if (!currentSettings.providerFamilyDomain && availability.families.includes(domain)) {
      await params.services.settingService.update(
        {
          providerFamilyDomain: domain,
          providerFamilyDomainUpdatedAt: Date.now(),
          providerFamilyDomainMigrated: true,
        },
        {
          providerFamilyDomain: currentSettings.providerFamilyDomain,
          providerFamilyConnectionSelections: currentSettings.providerFamilyConnectionSelections,
          providerFamilyDomainUpdatedAt: currentSettings.providerFamilyDomainUpdatedAt ?? 0,
        },
      );
    }
    return saved;
  }
  if (!availability.families.includes(domain)) return null;
  const familySpec = getModelProviderFamilySpec(domain);
  const expectedAccountSettings = {
    providerFamilyDomain: currentSettings.providerFamilyDomain,
    providerFamilyConnectionSelections: currentSettings.providerFamilyConnectionSelections,
    // 原因：相同身份重选不会改变映射，迟到操作仍须按锁内版本拒绝。
    providerFamilyDomainUpdatedAt: currentSettings.providerFamilyDomainUpdatedAt ?? 0,
  };
  const codingPlanProviderId = familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = familySpec.startPlanProviderId;
  const codingPlanProviderIds = [
    familySpec.individualCodingPlanProviderId,
    familySpec.startPlanProviderId,
    familySpec.teamCodingPlanProviderId,
  ];
  const { accesses, states, refreshed } = await refreshAccountProviderAccesses({
    services: params.services,
    providerIds: codingPlanProviderIds,
    reason: "oauth-login-entitlement",
  });
  if (!refreshed) return null;
  // 登录后的刷新也可能仍在等待旧 Team 补组织；未知不是可按排序重选的首次连接。
  if (
    !currentSettings.providerFamilyConnectionSelections?.[domain] &&
    codingPlanProviderIds.every((id) => states.get(id)?.availability === "unknown")
  )
    return null;

  const [codingPlanEntitlement, startPlanEntitlement, teamProducts] = await Promise.all([
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: codingPlanProviderId,
      accountAccess: accesses.get(codingPlanProviderId),
    }),
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: startPlanProviderId,
      accountAccess: accesses.get(startPlanProviderId),
    }),
    getEnterprisePricingProductsOrEmpty(params.services, domain),
  ]);
  // 旧 Start 连接只保留读取，不以权益失效为由删除或自动替换成付费连接。
  const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
    providerFamilyDomain: domain,
    codingPlanEntitlement,
    startPlanEntitlement,
    teamProducts,
    codingPlanAvailable: states.has(codingPlanProviderId)
      ? states.get(codingPlanProviderId)!.availability === "available"
      : undefined,
    startPlanAvailable: states.has(startPlanProviderId)
      ? states.get(startPlanProviderId)!.availability === "available"
      : undefined,
  });
  if (!selection) {
    return null;
  }

  const currentAccount = await params.services.oauthService.getAccountAvailability();
  if (
    currentAccount.userId !== availability.userId ||
    currentAccount.sessionRevision !== availability.sessionRevision
  )
    return null;
  await params.services.settingService.update(
    {
      providerFamilyDomain: domain,
      providerFamilyDomainUpdatedAt: Date.now(),
      providerFamilyDomainMigrated: true,
      providerFamilyConnectionSelections: {
        ...currentSettings.providerFamilyConnectionSelections,
        [domain]: selection,
      },
    },
    expectedAccountSettings,
  );
  return selection;
}

export async function refreshRestoredOAuthProviderFamilyAfterStartup(params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  if (!params.activeProvider) return null;
  const availability = await params.services.oauthService.getAccountAvailability();
  const storedSettings = await params.services.settingService.get();
  const settings = await correctUnusableProviderFamilyDomain(
    params.services,
    storedSettings,
    availability,
  );
  // Root 的设置缓存只在显式刷新时更新；纠正后必须同步，否则界面仍按旧 domain 展示。
  if (settings !== storedSettings) await params.refreshAppSettings?.();
  const domain = settings.providerFamilyDomain ?? availability.families[0] ?? null;
  if (!domain) return null;
  const saved = settings.providerFamilyConnectionSelections?.[domain];
  if (saved) {
    if (!settings.providerFamilyDomain) {
      await refreshLatestModelProviderFamilySelectionAfterLogin({
        provider: params.activeProvider,
        services: params.services,
      });
      await params.refreshAppSettings?.();
    }
    // 原因：启动时的不可用不是本次运行中发生的失效，不能替用户更换已保存连接。
    // 刷新账号事实仍照常执行；只有后续真实失效提示的点击动作允许选择替代套餐。
    try {
      await params.services.providerSettingsService.refresh("oauth-restore-entitlement");
    } catch (error) {
      logger.warn("[Root] 启动账号刷新失败，保留原连接", { error });
    }
    return saved;
  }
  try {
    // 仅真正没有选择才沿用首次初始化；该入口保留旧连接待迁移的 unknown 保护及条件写入。
    const selection = await refreshLatestModelProviderFamilySelectionAfterLogin({
      provider: params.activeProvider,
      services: params.services,
    });
    if (selection) await params.refreshAppSettings?.();
    return selection;
  } catch (error) {
    logger.warn("[Root] 启动初始化连接失败", { error });
    return null;
  }
}
