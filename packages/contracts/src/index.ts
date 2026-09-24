export { B2G_RELEASE, LAUNCHER_CONTENT, LAUNCHER_DOWNLOAD_FILENAME, LAUNCHER_DOWNLOAD_URL } from "./release.js";

export type QueuePhase = "idle" | "searching" | "ready-check" | "map-veto" | "assigned";
export type GameMode = "competitive" | "deathmatch";

export interface QueueState {
  /** Stable ticket identity for cancelling a closing client's exact search. */
  ticketId?: string;
  /** Omitted only by pre-mode compatibility clients; treated as competitive. */
  mode?: GameMode;
  phase: QueuePhase;
  joinedAt: string | null;
  regions: string[];
  maps: string[];
  playersFound: number;
  estimatedWaitSeconds: number;
  ratingWindow: number;
}

export interface ReadyCheck {
  mode?: GameMode;
  matchId: string;
  expiresAt: string;
  acceptedPlayerIds: string[];
  totalPlayers: number;
  map: string;
  mapPool: string[];
  region: string;
}

export type MapVetoTeam = "alpha" | "bravo";

export interface MapVetoBan {
  sequence: number;
  map: string;
  team: MapVetoTeam;
  captainPlayerId: string;
  automated: boolean;
  createdAt: string;
}

export interface MapVetoState {
  version: 1;
  matchId: string;
  region: string;
  captains: Record<MapVetoTeam, string>;
  actingTeam: MapVetoTeam;
  remainingMaps: string[];
  bans: MapVetoBan[];
  status: "active" | "allocating";
  selectedMap: string | null;
  expiresAt: string | null;
}

export interface MatchAssignment {
  mode?: GameMode;
  matchId: string;
  map: string;
  region: string;
  serverLabel: string;
  address: string;
  connectUrl: string;
  launcherUrl: string;
  /** Human-only occupancy for a drop-in Deathmatch session. */
  humanPlayers?: number;
  /** Engine-managed bots currently backfilling the Deathmatch session. */
  botPlayers?: number;
  /** Maximum simultaneous human players accepted by the session. */
  capacity?: number;
}

export interface LatencyProbeEndpoint {
  region: string;
  server: string;
  samples: number;
}

export interface LatencyProbeMeasurement {
  region: string;
  server: string;
  requestedSamples: number;
  successfulSamples: number;
  medianMs: number | null;
  p95Ms: number | null;
  packetLossPercent: number;
  measuredAt?: string;
  validUntil?: string;
}

export interface LatencyProbeChallenge {
  version: 1;
  challengeId: string;
  expiresAt: string;
  endpoints: LatencyProbeEndpoint[];
  launcherUrl: string;
}

export interface LatencyProbeStatus {
  enabled: boolean;
  regions: string[];
  measurements: LatencyProbeMeasurement[];
}

export interface LatencyProbeSubmission {
  version: 1;
  challengeId: string;
  measurements: LatencyProbeMeasurement[];
}

export interface PartyMember {
  playerId: string;
  ready: boolean;
  joinedAt: string;
  displayName?: string;
  initials?: string;
  rank?: RankView;
}

export interface PartyState {
  id: string;
  leaderPlayerId: string;
  members: PartyMember[];
  createdAt: string;
  version: number;
}

export interface PartyInvite {
  id: string;
  partyId: string;
  inviterPlayerId: string;
  invitedPlayerId: string;
  createdAt: string;
  expiresAt: string;
}

export interface RankView {
  name: string;
  shortName: string;
  rating: number;
  nextRank: string | null;
  nextRankFloor: number | null;
  progress: number;
}

export interface RecentMatch {
  id: string;
  map: string;
  score: string;
  outcome: "W" | "L" | "D";
  ratingDelta: number;
  adr: number;
  kills: number;
  deaths: number;
  playedAt: string;
  hasDemo?: boolean;
  analysisStatus?: "uploaded" | "analyzed" | "invalid" | "deleted" | null;
  mode?: GameMode;
}

export interface RatingHistoryPoint {
  matchId: string;
  previousRating: number;
  rating: number;
  delta: number;
  outcome: "win" | "loss" | "draw";
  settledAt: string;
}

export type { FriendRelationship, SocialPlayer, FriendsPage, LauncherSocialProfile } from "./social.js";

export interface PlayerProfile extends PlayerView {
  totals: {
    wins: number;
    losses: number;
    draws: number;
    kills: number;
    deaths: number;
    assists: number;
    averageAdr: number;
    averageKast: number;
  };
  ratingHistory: RatingHistoryPoint[];
}

export interface LeaderboardEntry {
  position: number;
  playerId: string;
  displayName: string;
  region: string;
  rating: number;
  rank: string;
  matchesPlayed: number;
  winRate: number;
}

export interface MatchPlayerDetails {
  playerId: string;
  displayName: string;
  team: "alpha" | "bravo" | "ffa";
  slot: number;
  ratingAtMatch: number;
  ratingDelta: number;
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  kast: number;
  openingKills: number;
  openingDeaths: number;
  trades: number;
  clutches: number;
  flashAssists: number;
  utilityDamage: number;
}

export interface MatchDetails {
  id: string;
  map: string;
  region: string;
  status: "pending" | "live" | "completed" | "cancelled" | "disputed";
  score: { alpha: number | null; bravo: number | null };
  startedAt: string | null;
  endedAt: string | null;
  rulesetVersion: string;
  mode?: GameMode;
  teams: { alpha: MatchPlayerDetails[]; bravo: MatchPlayerDetails[]; ffa?: MatchPlayerDetails[] };
  demo: {
    available: boolean;
    checksum: string;
    sizeBytes: number;
    analysisStatus: "uploaded" | "analyzed" | "invalid" | "deleted";
    analyzerVersion: string | null;
    warnings: string[];
    downloadUrl: string | null;
  } | null;
}

export interface PlayerView {
  id: string;
  displayName: string;
  initials: string;
  region: string;
  rank: RankView;
  matchesPlayed: number;
  winRate: number;
  recentMatches: RecentMatch[];
  platformRole?: "player" | "moderator" | "admin";
  onboardingRequired?: boolean;
  settings?: AccountSettings;
}

export interface AccountSettings {
  preferredMode: GameMode;
  profileVisibility: "public" | "players" | "private";
  allowPartyInvites: boolean;
  matchNotifications: boolean;
  productUpdates: boolean;
  reducedMotion: boolean;
}

export interface CosmeticInventoryItem {
  assetId: string;
  source: "steam" | "b2g";
  itemKind: "cosmetic" | "case" | "key";
  classId: string;
  instanceId: string;
  definitionIndex: number;
  weaponKey: string;
  displayName: string;
  marketHashName: string;
  iconPath: string | null;
  iconUrl: string | null;
  tradable: boolean;
  marketable: boolean;
  selected: boolean;
}

export interface CosmeticInventoryView {
  status: "public" | "private" | "unavailable";
  refreshedAt: string | null;
  nextRefreshAt: string;
  itemCount: number;
  items: CosmeticInventoryItem[];
  /** Matching local GCs expose verified owned items through the native loadout UI. */
  serverApplication: "owned-native-loadout";
}

export interface CosmeticLoadoutSelection {
  weaponKey: string;
  assetId: string;
}

export interface LauncherDeviceAuthorization {
  version: 1;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface LauncherDeviceApproval {
  version: 1;
  status: "approved";
  userCode: string;
  expiresAt: string;
}

export type LauncherTokenExchange = {
  version: 1;
  status: "pending";
  retryAfterSeconds: number;
} | {
  version: 1;
  status: "authorized";
  accessToken: string;
  expiresAt: string;
};

export interface PlatformControls {
  registrationEnabled: boolean;
  queueEnabled: boolean;
  serverAllocationEnabled: boolean;
  userMessage: string | null;
  version: number;
  updatedAt: string;
}

export type ReportCategory = "cheating" | "griefing" | "toxicity" | "smurfing" | "platform_abuse";
export type ReportStatus = "pending" | "under_review" | "resolved" | "dismissed";

export interface PlayerReport {
  id: string;
  reporterId: string;
  reportedId: string;
  reportedDisplayName: string;
  matchId: string;
  category: ReportCategory;
  status: ReportStatus;
  description: string | null;
  reviewerId: string | null;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type SanctionType = "cooldown" | "warning" | "temp_ban" | "perm_ban";

export interface PlayerSanction {
  id: string;
  playerId: string;
  displayName: string;
  issuedBy: string | null;
  sanctionType: SanctionType;
  reason: string;
  reportId: string | null;
  matchId: string | null;
  startsAt: string;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface SanctionAppeal {
  id: string;
  sanctionId: string;
  playerId: string;
  displayName: string;
  statement: string;
  status: "pending" | "upheld" | "reduced" | "overturned";
  reviewerId: string | null;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export interface AntiCheatSignal {
  id: string;
  matchId: string;
  playerId: string | null;
  steamId: string;
  displayName: string;
  module: string;
  detectionType: number;
  mode: GameMode;
  map: string;
  matchStatus: MatchDetails["status"];
  occurredAt: string;
  automaticAction: false;
  synthetic: boolean;
}

export type MatchRecoveryStatus = "open" | "resolving" | "resolved";
export type MatchRecoveryAction = "remake" | "void";

export interface MatchRecoveryIncident {
  id: string;
  matchId: string;
  map: string;
  region: string;
  matchStatus: MatchDetails["status"];
  reason: "server_lease_expired";
  status: MatchRecoveryStatus;
  evidence: Record<string, unknown>;
  detectedAt: string;
  resolutionAction: MatchRecoveryAction | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  replacementMatchId: string | null;
  replacementAssignment: MatchAssignment | null;
  queueReassignedPlayers: number;
  queueDeliveryError: string | null;
  resolutionError: string | null;
}

export interface BootstrapResponse {
  player: PlayerView;
  queue: QueueState;
  readyCheck: ReadyCheck | null;
  mapVeto: MapVetoState | null;
  assignment: MatchAssignment | null;
  platform: {
    onlinePlayers: number;
    activeMatches: number;
    season: string;
    competitiveQueuePlayers?: number;
    deathmatchQueuePlayers?: number;
    deathmatchHumans?: number;
    deathmatchBots?: number;
    deathmatchCapacity?: number;
    controls?: PlatformControls;
  };
}

export interface LauncherGameProfile {
  steamId: string;
  competitiveRankId: number;
  competitiveWins: number;
  playerLevel: number;
  playerXp: number;
  serviceDropCount: number;
  b2gInventoryVersion: number;
}

export interface LauncherEditorialItem {
  title: string;
  summary: string;
}

export interface LauncherClientContent {
  version: 1;
  releaseVersion: string;
  channel: string;
  publishedAt: string;
  changelog: LauncherEditorialItem;
  news: LauncherEditorialItem;
  history?: Array<{
    version: string;
    date: string;
    changes: Array<{ kind: string; text: string }>;
  }>;
}

export interface LauncherBootstrapResponse extends BootstrapResponse {
  gameProfile: LauncherGameProfile;
  launcher: {
    content: LauncherClientContent;
  };
}

export interface LauncherPlayerProfile {
  accountId: number;
  competitiveRankId: number;
  competitiveWins: number;
  playerLevel: number;
  playerXp: number;
}

export interface LauncherPlayerProfilesResponse {
  version: 1;
  profiles: LauncherPlayerProfile[];
}

export interface LauncherLatencyChallenge {
  enabled: boolean;
  launcherUrl: string | null;
  expiresAt?: string;
}

export type ServerEvent =
  | { type: "queue.updated"; payload: QueueState }
  | { type: "match.found"; payload: ReadyCheck }
  | { type: "match.accepted"; payload: ReadyCheck }
  | { type: "match.veto.updated"; payload: MapVetoState }
  | { type: "match.assigned"; payload: MatchAssignment }
  | { type: "queue.cancelled"; payload: QueueState };

export interface JoinQueueRequest {
  playerId: string;
  regions: string[];
  maps: string[];
  mode?: GameMode;
}
export type {
  TradeStatus, TradeAction, TradingPlayer, TradingItem, TradeTermsInput,
  TradeOfferView, TradeOfferSummary, TradeEventView, TradingOverview
} from "./trading.js";
export { isOwnershipGeneration } from "./trading.js";
