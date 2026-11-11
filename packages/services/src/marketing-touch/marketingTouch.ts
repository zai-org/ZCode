import { ServiceChannels, type Locale, type MarketingTouchSnapshot } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface IMarketingTouchService {
  query(input: { locale: Locale }): Promise<MarketingTouchSnapshot & { scope: string }>;
  report(input: {
    locale: Locale;
    scope: string;
    campaignId: string;
    actionType: "confirm" | "cancel";
  }): Promise<void>;
}
export const IMarketingTouchService = createServiceDescriptor<IMarketingTouchService>(
  ServiceChannels.MarketingTouch,
);
