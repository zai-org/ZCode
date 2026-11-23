import {
  resolvePreinstalledToolsCatalog,
  resolvePreinstalledToolsRelease,
  type PreinstalledToolCatalogEntry,
} from "@zcode/shared/preinstalled-tools";

export const previewReleaseExample = resolvePreinstalledToolsRelease({
  runtimeEnv: "production",
  productFlavor: "preview",
});

/** 只有已发布条目才可装配；基址由调用方按地域或覆盖变量给出。 */
export function publishedResourceExample(entry: PreinstalledToolCatalogEntry) {
  return resolvePreinstalledToolsCatalog([entry], "darwin", "arm64", [
    "https://cdn.example.com/zcode/preinstalled-tools",
  ]).tools;
}
