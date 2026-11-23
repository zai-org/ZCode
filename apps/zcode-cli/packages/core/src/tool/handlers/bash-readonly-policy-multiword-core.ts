import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import {
  dockerCommandIsDangerous,
  ghCommandIsDangerous,
  zipinfoCommandIsDangerous,
} from "./bash-readonly-policy-callbacks.js";
import {
  DOCKER_INSPECT_SAFE_FLAGS,
  DOCKER_LOGS_SAFE_FLAGS,
  ZIPINFO_SAFE_FLAGS,
} from "./bash-readonly-policy-flags.js";

export const READONLY_MULTIWORD_POLICY_ENTRIES_CORE = [
  [
    "docker inspect",
    {
      safeFlags: DOCKER_INSPECT_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: dockerCommandIsDangerous,
    },
  ],
  [
    "docker logs",
    {
      safeFlags: DOCKER_LOGS_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: dockerCommandIsDangerous,
    },
  ],
  [
    "gh auth status",
    {
      safeFlags: {
        "-a": "none",
        "-h": "string",
        "--active": "none",
        "--hostname": "string",
        "--json": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  // Info-ZIP 只在 -Z 是第一个参数时进入 zipinfo 模式，后面的参数都按 zipinfo 解析，不会解压。
  [
    "unzip -Z",
    {
      safeFlags: ZIPINFO_SAFE_FLAGS,
      respectsDoubleDash: false,
      additionalCommandIsDangerousCallback: zipinfoCommandIsDangerous,
    },
  ],
] as const satisfies readonly (readonly [string, BashReadonlyCommandPolicy])[];
