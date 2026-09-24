import type {
  AntiCheatSignal,
  AuditEntry,
  BootstrapResponse,
  AccountSettings,
  CosmeticInventoryView,
  CosmeticLoadoutSelection,
  GameMode,
  JoinQueueRequest,
  LauncherDeviceApproval,
  LeaderboardEntry,
  LatencyProbeChallenge,
  LatencyProbeStatus,
  MapVetoState,
  MatchAssignment,
  MatchDetails,
  MatchRecoveryAction,
  MatchRecoveryIncident,
  PartyInvite,
  PartyState,
  PlayerProfile,
  RecentMatch,
  PlayerReport,
  PlayerSanction,
  PlatformControls,
  ReportCategory,
  ReportStatus,
  QueueState,
  ReadyCheck,
  SanctionAppeal,
  SanctionType,
  ServerEvent
} from "@aftertick/contracts";

export interface AuthState {
  authenticated: boolean;
  playerId?: string;
  steamId?: string;
  displayName?: string;
}

let csrfTokenPromise: Promise<string> | undefined;

async function loadCsrfToken(): Promise<string> {
  const response = await fetch("/api/auth/csrf", {
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error("Could not establish a secure request session.");
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}

function csrfToken(): Promise<string> {
  csrfTokenPromise ??= loadCsrfToken().catch((error) => {
    csrfTokenPromise = undefined;
    throw error;
  });
  return csrfTokenPromise;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const csrfHeaders = ["GET", "HEAD", "OPTIONS"].includes(method)
    ? {}
    : { "X-CSRF-Token": await csrfToken() };
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...csrfHeaders,
      ...init?.headers
    }
  });

  if (response.status === 401) {
    throw new AuthError("Not authenticated.");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export const api = {
  checkAuth: (): Promise<AuthState> =>
    request("/api/auth/me"),

  approveLauncher: (userCode: string): Promise<LauncherDeviceApproval> =>
    request("/api/launcher/v1/device/approve", {
      method: "POST",
      body: JSON.stringify({ userCode })
    }),

  logout: (): Promise<void> =>
    request("/api/auth/logout", { method: "POST" }),

  bootstrap: (): Promise<BootstrapResponse> =>
    request("/api/bootstrap"),

  completeOnboarding: (displayName: string, region: string): Promise<BootstrapResponse["player"]> =>
    request("/api/account/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ displayName, region })
    }),

  updateAccountSettings: (settings: AccountSettings & { region: string }): Promise<BootstrapResponse["player"]> =>
    request("/api/account/settings", {
      method: "PATCH",
      body: JSON.stringify(settings)
    }),

  cosmeticInventory: (): Promise<CosmeticInventoryView> =>
    request("/api/account/inventory"),

  refreshCosmeticInventory: (): Promise<CosmeticInventoryView> =>
    request("/api/account/inventory/refresh", { method: "POST" }),

  saveCosmeticLoadout: (selections: CosmeticLoadoutSelection[]): Promise<CosmeticInventoryView> =>
    request("/api/account/loadout", {
      method: "PUT",
      body: JSON.stringify({ selections })
    }),

  playerProfile: (playerId: string): Promise<PlayerProfile> =>
    request(`/api/players/${encodeURIComponent(playerId)}`),

  playerMatches: (playerId: string, limit = 50, offset = 0): Promise<{ entries: RecentMatch[]; total: number }> =>
    request(`/api/players/${encodeURIComponent(playerId)}/matches?limit=${limit}&offset=${offset}`),

  leaderboard: (region?: string): Promise<{ entries: LeaderboardEntry[] }> => {
    const query = region ? `?region=${encodeURIComponent(region)}` : "";
    return request(`/api/leaderboard${query}`);
  },

  matchDetails: (matchId: string): Promise<MatchDetails> =>
    request(`/api/matches/${encodeURIComponent(matchId)}`),

  createReport: (input: {
    reportedId: string;
    matchId: string;
    category: ReportCategory;
    description: string | null;
  }): Promise<PlayerReport> =>
    request("/api/reports", { method: "POST", body: JSON.stringify(input) }),

  sanctions: (): Promise<{ sanctions: PlayerSanction[] }> =>
    request("/api/sanctions"),

  appealSanction: (sanctionId: string, statement: string) =>
    request(`/api/sanctions/${encodeURIComponent(sanctionId)}/appeals`, {
      method: "POST",
      body: JSON.stringify({ statement })
    }),

  platformControls: (): Promise<PlatformControls> =>
    request("/api/platform/controls"),

  moderationReports: (status: ReportStatus = "pending"): Promise<{ reports: PlayerReport[] }> =>
    request(`/api/moderation/reports?status=${encodeURIComponent(status)}`),

  reviewReport: (reportId: string, status: "under_review" | "resolved" | "dismissed", resolution: string | null): Promise<PlayerReport> =>
    request(`/api/moderation/reports/${encodeURIComponent(reportId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status, resolution })
    }),

  createSanction: (input: {
    playerId: string;
    sanctionType: SanctionType;
    reason: string;
    durationMinutes: number | null;
    reportId: string | null;
    matchId: string | null;
  }): Promise<PlayerSanction> =>
    request("/api/moderation/sanctions", { method: "POST", body: JSON.stringify(input) }),

  moderationAppeals: (): Promise<{ appeals: SanctionAppeal[] }> =>
    request("/api/moderation/appeals?status=pending"),

  antiCheatSignals: (): Promise<{ signals: AntiCheatSignal[] }> =>
    request("/api/moderation/anticheat-signals"),

  resolveAppeal: (
    appealId: string,
    status: "upheld" | "reduced" | "overturned",
    resolution: string,
    newDurationMinutes: number | null
  ): Promise<SanctionAppeal> =>
    request(`/api/moderation/appeals/${encodeURIComponent(appealId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status, resolution, newDurationMinutes })
    }),

  adminControls: (): Promise<PlatformControls> =>
    request("/api/admin/controls"),

  updateAdminControls: (controls: Omit<PlatformControls, "updatedAt">): Promise<PlatformControls> =>
    request("/api/admin/controls", { method: "PATCH", body: JSON.stringify(controls) }),

  audit: (): Promise<{ entries: AuditEntry[] }> =>
    request("/api/admin/audit"),

  matchRecovery: (): Promise<{ incidents: MatchRecoveryIncident[] }> =>
    request("/api/admin/match-recovery"),

  resolveMatchRecovery: (
    incidentId: string,
    action: MatchRecoveryAction,
    note: string
  ): Promise<MatchRecoveryIncident> =>
    request(`/api/admin/match-recovery/${encodeURIComponent(incidentId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ action, note })
    }),

  party: (): Promise<{ party: PartyState | null }> =>
    request("/api/party"),

  partyInvites: (): Promise<{ invites: PartyInvite[] }> =>
    request("/api/party/invites"),

  createParty: (): Promise<PartyState> =>
    request("/api/party", { method: "POST" }),

  inviteToParty: (playerId: string): Promise<PartyInvite> =>
    request("/api/party/invites", {
      method: "POST",
      body: JSON.stringify({ playerId })
    }),

  acceptPartyInvite: (inviteId: string): Promise<PartyState> =>
    request(`/api/party/invites/${encodeURIComponent(inviteId)}/accept`, { method: "POST" }),

  setPartyReady: (ready: boolean): Promise<PartyState> =>
    request("/api/party/ready", {
      method: "PATCH",
      body: JSON.stringify({ ready })
    }),

  transferPartyLeader: (playerId: string): Promise<PartyState> =>
    request("/api/party/leader", {
      method: "PATCH",
      body: JSON.stringify({ playerId })
    }),

  leaveParty: (): Promise<{ party: PartyState | null }> =>
    request("/api/party", { method: "DELETE" }),

  latencyProbes: (): Promise<LatencyProbeStatus> =>
    request("/api/latency-probes"),

  createLatencyProbe: (regions: string[]): Promise<LatencyProbeChallenge> =>
    request("/api/latency-probes/challenges", {
      method: "POST",
      body: JSON.stringify({ regions })
    }),

  joinQueue: (regions: string[], maps: string[], mode: GameMode): Promise<QueueState> =>
    request<QueueState>("/api/queue/join", {
      method: "POST",
      body: JSON.stringify({
        regions,
        maps: mode === "deathmatch" ? [] : maps,
        mode
      } satisfies Omit<JoinQueueRequest, "playerId">)
    }),

  platform: (): Promise<BootstrapResponse["platform"]> =>
    request("/api/platform"),

  leaveQueue: (): Promise<QueueState> =>
    request<QueueState>("/api/queue/leave", { method: "POST" }),

  acceptMatch: (matchId: string): Promise<ReadyCheck | MapVetoState | MatchAssignment> =>
    request(`/api/matches/${encodeURIComponent(matchId)}/accept`, {
      method: "POST"
    }),

  banMap: (matchId: string, map: string): Promise<MapVetoState> =>
    request(`/api/matches/${encodeURIComponent(matchId)}/veto`, {
      method: "POST",
      body: JSON.stringify({ map })
    }),

  reset: (): Promise<BootstrapResponse> =>
    request("/api/dev/reset", { method: "POST" }),

  events: (
    onEvent: (event: ServerEvent) => void,
    onConnectionChange: (connected: boolean) => void
  ): (() => void) => {
    const source = new EventSource("/api/events");
    source.onopen = () => onConnectionChange(true);
    source.onerror = () => onConnectionChange(false);
    source.onmessage = (message) => {
      onEvent(JSON.parse(message.data) as ServerEvent);
    };
    return () => source.close();
  }
};
