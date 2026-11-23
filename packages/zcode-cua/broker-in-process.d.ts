export interface StartInProcessComputerUseBrokerOptions {
  socketPath?: string;
  addonPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InProcessComputerUseBroker {
  readonly socketPath: string;
  stop(): Promise<void>;
}

export declare function startInProcessComputerUseBroker(
  options?: StartInProcessComputerUseBrokerOptions,
): Promise<InProcessComputerUseBroker>;
