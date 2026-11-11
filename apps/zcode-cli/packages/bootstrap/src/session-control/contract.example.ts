import { createAppSessionControlBinding } from "./index.js";
import type { AppSessionControlBindingOptions } from "./contract.js";

export function bindAppSessionControl(options: AppSessionControlBindingOptions) {
  return createAppSessionControlBinding(options);
}
