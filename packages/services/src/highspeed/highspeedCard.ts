import type {
  HighspeedCardUsage,
  HighspeedPrepareTurnParams,
  HighspeedPrepareTurnResult,
  HighspeedServiceSnapshot,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IHighspeedCardService {
  prepareTurn(params: HighspeedPrepareTurnParams): Promise<HighspeedPrepareTurnResult>;
  getSnapshot(): Promise<HighspeedServiceSnapshot>;
  invalidateCard(cardId: string): Promise<boolean>;
  getCurrentOwnerKey(): Promise<string | null>;
  healthy(cardId: string, ownerKey?: string): Promise<HighspeedCardUsage | null>;
}

export const IHighspeedCardService = createServiceDescriptor<IHighspeedCardService>(
  ServiceChannels.HighspeedCard,
);
