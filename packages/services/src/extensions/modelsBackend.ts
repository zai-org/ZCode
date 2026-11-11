import { ExtensionError, type ExtensionModel } from "@zcode/shared/extension-host";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

// 能力 models.list 的后端（docs/plugins/extension-host.md §18.1 H9，① 调现有服务）：
// 读输入框模型选择器同一份视图（IModelSelectionService.getView），隐藏的 provider 已由它过滤。

export interface ModelsBackendDeps {
  /** Window Host 的模型选择服务；没有时 models.list 报 unavailable。 */
  modelSelection: Pick<IModelSelectionService, "getView"> | undefined;
  logger: Pick<ServiceLogger, "debug">;
}

export interface ModelsBackend {
  list(): Promise<ExtensionModel[]>;
}

export function createModelsBackend(deps: ModelsBackendDeps): ModelsBackend {
  return {
    async list() {
      if (!deps.modelSelection) {
        throw new ExtensionError("unavailable", "model selection is unavailable");
      }
      const view = await deps.modelSelection.getView();
      // 与选择器相同：provider 的显示名缺省用 providerId，模型标签就是 modelId。
      const models = view.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          id: `${provider.providerId}/${model.modelId}`,
          providerId: provider.providerId,
          modelId: model.modelId,
          label: model.modelId,
          providerName: provider.providerName?.trim() || provider.providerId,
        })),
      );
      deps.logger.debug(undefined, `models.list returned ${models.length} models`);
      return models;
    },
  };
}
