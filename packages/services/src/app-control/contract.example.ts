import type { AppControlBinding, AppControlService } from "#src/app-control/contract.js";

export async function discoverAppSessions(service: AppControlService, binding: AppControlBinding) {
  const context = await service.bind(binding);
  return service.control.listSessions(context, { archived: "exclude" });
}
