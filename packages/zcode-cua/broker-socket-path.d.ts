export declare const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export declare const IN_PROCESS_BROKER_SOCKET = "in-process";
export declare function mintBrokerSocketPath(options?: {
  dir?: string;
  env?: Record<string, string | undefined>;
}): string;
export declare function resolveBrokerSocketPath(options?: {
  dir?: string;
  env?: Record<string, string | undefined>;
}): string;
