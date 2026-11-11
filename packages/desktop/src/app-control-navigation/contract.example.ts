import type { AppControlNavigationWindow } from "#src/app-control-navigation/contract.js";

export function registerNavigationSurface(surface: AppControlNavigationWindow) {
  surface.register("renderer-generation");
  return () => surface.unregister("renderer-generation");
}
