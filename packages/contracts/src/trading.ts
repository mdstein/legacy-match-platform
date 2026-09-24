export type TradeStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired" | "invalidated";
export type TradeAction = "accept" | "decline" | "cancel";

export function isOwnershipGeneration(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n;
}

export interface TradingPlayer {
  playerId: string;
  displayName: string;
  tradeCode: string;
  allowOffers: boolean;
}

export interface TradingItem {
  assetId: string;
  ownerId: string;
  ownershipGeneration: string;
  itemKind: "case" | "key" | "cosmetic";
  definitionIndex: number;
  weaponKey: string;
  displayName: string;
  iconPath: string | null;
  imageUrl?: string | null;
  paintIndex: number | null;
  paintWear: number | null;
  paintSeed: number | null;
  quality: number;
  rarity: number;
  origin: number;
  statTrak: boolean;
  statTrakCount: number | null;
  customName: string | null;
  stickers: Array<{ slot: number; stickerId: number; wear: number | null; scale: number | null; rotation: number | null }>;
  sprayKitId: number | null;
  sprayTintId: number | null;
  spraysRemaining: number | null;
  equipped: boolean;
  tradable: boolean;
  restriction: string | null;
  fingerprint: string;
}

export interface TradeTermsInput {
  giveAssetIds: string[];
  receiveAssetIds: string[];
  itemFingerprints: Record<string, string>;
  message?: string;
  confirmGift?: boolean;
}

export interface TradeOfferView {
  id: string;
  revision: number;
  status: TradeStatus;
  statusReason: string | null;
  senderId: string;
  participants: TradingPlayer[];
  message: string;
  items: TradingItem[];
  changedAssetIds: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt: string | null;
}

export interface TradeEventView {
  id: string;
  offerId: string;
  revision: number;
  actorId: string | null;
  kind: "sent" | "countered" | Exclude<TradeStatus, "pending">;
  createdAt: string;
  detail: Record<string, unknown>;
}

/** Folder rows are summaries; open an offer to fetch and review exact items. */
export type TradeOfferSummary = Omit<TradeOfferView, "items" | "changedAssetIds"> & { itemCount: number };

export interface TradingOverview {
  enabled: boolean;
  player: TradingPlayer;
  incomingCount: number;
  unreadCount: number;
  latestEventId: string;
  limits: { itemsPerSide: number; activeOffers: number; visibleInventory: number; expiryDays: number };
}
