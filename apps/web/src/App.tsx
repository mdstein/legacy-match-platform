import type {
  BootstrapResponse,
  AccountSettings,
  GameMode,
  LatencyProbeStatus,
  LeaderboardEntry,
  MatchDetails,
  MatchPlayerDetails,
  PartyInvite,
  PartyState,
  PlayerProfile,
  PlayerSanction,
  ReportCategory,
  QueueState,
  ReadyCheck,
  RecentMatch,
  ServerEvent
} from "@aftertick/contracts";
import {
  Check,
  LoaderCircle,
  Shield,
  Terminal,
  Trophy,
  WifiOff
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, AuthError, type AuthState } from "./api.js";
import { applyAcceptResult, applyServerEvent } from "./app-state.js";
import { MatchHistory } from "./components/MatchHistory.js";
import { MapVetoDialog } from "./components/MapVetoDialog.js";
import { LeaderboardDialog } from "./components/LeaderboardDialog.js";
import { DisciplineDialog } from "./components/DisciplineDialog.js";
import { MatchDetailsDialog } from "./components/MatchDetailsDialog.js";
import { PlayerSidebar } from "./components/PlayerSidebar.js";
import { OperationsDialog } from "./components/OperationsDialog.js";
import { ReportDialog } from "./components/ReportDialog.js";
import { QueuePanel } from "./components/QueuePanel.js";
import { ReadyCheckDialog } from "./components/ReadyCheckDialog.js";
import { LauncherGuideDialog } from "./components/LauncherGuideDialog.js";
import { LauncherHome } from "./components/LauncherHome.js";
import { AccountPage } from "./components/AccountPage.js";
import { BrandMark } from "./components/BrandMark.js";
import { MatchesPage } from "./components/MatchesPage.js";
import { OnboardingDialog } from "./components/OnboardingDialog.js";
import { ConnectionStatus } from "./components/ConnectionStatus.js";
import { ImpeccablePreview } from "./components/ImpeccablePreview.js";
import { AccountMenu } from "./components/AccountMenu.js";
import { PlayerProfilePage } from "./components/PlayerProfilePage.js";
import { LauncherAuthorizationDialog } from "./components/LauncherAuthorizationDialog.js";

type ActiveView = "play" | "matches" | "account" | "profile";

function formatElapsed(joinedAt: string | null): string {
  if (!joinedAt) return "00:00";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(joinedAt).getTime()) / 1000)
  );
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function LoadingScreen() {
  return (
    <main className="loading-shell" aria-label="Loading">
      <BrandMark />
      <div className="loading-bar">
        <div className="loading-bar-fill" />
      </div>
      <p>Connecting…</p>
    </main>
  );
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  steam_auth_state: "The Steam login session expired or was opened in a different browser. Please try again.",
  steam_auth_failed: "Steam did not verify this sign-in. Please try again from this page.",
  steam_profile_failed: "Steam verified the account, but the profile could not be loaded.",
  auth_error: "The Steam sign-in could not be completed. Please try again."
};

function LoginScreen({ errorCode }: { errorCode: string | null }) {
  const errorMessage = errorCode ? AUTH_ERROR_MESSAGES[errorCode] : null;
  const hasLauncherCode = new URLSearchParams(window.location.search).has("launcher_code");
  const steamLoginUrl = hasLauncherCode
    ? `/api/auth/steam?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`
    : "/api/auth/steam";
  return (
    <main className="login-shell">
      <div className="login-card">
        <BrandMark />
        <h1>{hasLauncherCode ? "Connect your B2G launcher" : "Come back to the game that felt right."}</h1>
        <p className="login-tagline">{hasLauncherCode ? "Sign in with Steam, approve the matching code, then finish your B2G profile in the launcher." : "Private alpha for community-run 128-tick Competitive and Deathmatch in CS:GO."}</p>
        {errorMessage && <p className="login-error" role="alert">{errorMessage}</p>}
        <a className="btn btn--steam" href={steamLoginUrl}>
          Continue with Steam
        </a>
        <p className="login-note">
          Steam verifies ownership. B2G never sees your password.
        </p>
      </div>
    </main>
  );
}

export function App() {
  const preview = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get("impeccable") === "hero";
  return preview ? <ImpeccablePreview /> : <Application />;
}

function Application() {
  const legacyQueuePreview = import.meta.env.MODE === "e2e"
    && new URLSearchParams(window.location.search).get("legacy_queue") === "1";
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [selectedMaps, setSelectedMaps] = useState<string[]>([
    "Mirage", "Inferno", "Nuke", "Overpass", "Vertigo", "Ancient", "Anubis"
  ]);
  const [selectedRegions, setSelectedRegions] = useState<string[]>(["NA Central"]);
  const [selectedMode, setSelectedMode] = useState<GameMode>("competitive");
  const [activeView, setActiveView] = useState<ActiveView>("play");
  const [profileReturnView, setProfileReturnView] = useState<Exclude<ActiveView, "profile">>("play");
  const [connectionLive, setConnectionLive] = useState(false);
  const [latencyProbes, setLatencyProbes] = useState<LatencyProbeStatus | null>(null);
  const [probePending, setProbePending] = useState(false);
  const [probeIssuedAt, setProbeIssuedAt] = useState<number | null>(null);
  const [probeDeadline, setProbeDeadline] = useState<number | null>(null);
  const [probeLauncherUrl, setProbeLauncherUrl] = useState<string | null>(null);
  const [probeHandoffSlow, setProbeHandoffSlow] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [acceptPending, setAcceptPending] = useState(false);
  const [vetoPending, setVetoPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [party, setParty] = useState<PartyState | null>(null);
  const [partyInvites, setPartyInvites] = useState<PartyInvite[]>([]);
  const [partyPending, setPartyPending] = useState(false);
  const [partyError, setPartyError] = useState<string | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [matchArchive, setMatchArchive] = useState<RecentMatch[] | null>(null);
  const [matchArchiveTotal, setMatchArchiveTotal] = useState(0);
  const [matchArchivePending, setMatchArchivePending] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[] | null>(null);
  const [matchDetails, setMatchDetails] = useState<MatchDetails | null>(null);
  const [detailPending, setDetailPending] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<{
    matchId: string;
    playerId: string;
    displayName: string;
  } | null>(null);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [launcherGuideOpen, setLauncherGuideOpen] = useState(false);
  const [sanctions, setSanctions] = useState<PlayerSanction[] | null>(null);
  const [clock, forceClock] = useState(0);
  const [onboardingPending, setOnboardingPending] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [settingsPending, setSettingsPending] = useState(false);
  const [launcherCode, setLauncherCode] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("launcher_code")
  );
  const [launcherApprovalPending, setLauncherApprovalPending] = useState(false);
  const [launcherApproved, setLauncherApproved] = useState(false);
  const [launcherApprovalError, setLauncherApprovalError] = useState<string | null>(null);

  const patchQueue = useCallback((queue: QueueState) => {
    setData((prev) => (prev ? { ...prev, queue } : prev));
  }, []);

  const normalizedLauncherCode = launcherCode?.trim().toUpperCase() ?? null;
  const validLauncherCode = normalizedLauncherCode
    && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(normalizedLauncherCode)
    ? normalizedLauncherCode
    : null;

  const clearLauncherAuthorization = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("launcher_code");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setLauncherCode(null);
    setLauncherApproved(false);
    setLauncherApprovalError(null);
  };

  const approveLauncher = async () => {
    if (!validLauncherCode || launcherApprovalPending) return;
    setLauncherApprovalPending(true);
    setLauncherApprovalError(null);
    try {
      await api.approveLauncher(validLauncherCode);
      setLauncherApproved(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("launcher_code");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    } catch (caught) {
      setLauncherApprovalError(
        caught instanceof Error ? caught.message : "The launcher could not be connected."
      );
    } finally {
      setLauncherApprovalPending(false);
    }
  };

  const onServerEvent = useCallback((event: ServerEvent) => {
    setData((prev) => (prev ? applyServerEvent(prev, event) : prev));
  }, []);

  const refreshParty = useCallback(async () => {
    const [current, pendingInvites] = await Promise.all([
      api.party(),
      api.partyInvites()
    ]);
    setParty(current.party);
    setPartyInvites(pendingInvites.invites);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeView, profile?.id]);

  // Check auth on mount
  useEffect(() => {
    api.checkAuth()
      .then((state) => {
        setAuth(state);
        setAuthChecked(true);
      })
      .catch(() => {
        setAuth({ authenticated: false });
        setAuthChecked(true);
      });
  }, []);

  // Bootstrap + SSE after auth confirmed
  useEffect(() => {
    if (!auth?.authenticated) return;

    let active = true;
    api
      .bootstrap()
      .then((bootstrap) => {
        if (!active) return;
        setData(bootstrap);
        setSelectedMaps(bootstrap.queue.maps);
        setSelectedRegions(bootstrap.queue.regions);
        setSelectedMode(bootstrap.queue.mode ?? bootstrap.player.settings?.preferredMode ?? "competitive");
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof AuthError) {
          setAuth({ authenticated: false });
          return;
        }
        setError(err instanceof Error ? err.message : "Could not reach the server.");
      });
    api.latencyProbes()
      .then((status) => {
        if (!active) return;
        setLatencyProbes(status);
        if (status.enabled && status.regions.length > 0) {
          setSelectedRegions((current) => status.regions.includes(current[0] ?? "")
            ? current
            : [status.regions[0]!]);
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load route measurements.");
      });
    const stop = api.events(onServerEvent, setConnectionLive);
    return () => {
      active = false;
      stop();
    };
  }, [auth?.authenticated, onServerEvent]);

  useEffect(() => {
    if (!probePending || probeIssuedAt === null || probeDeadline === null) return;
    let active = true;
    const update = async () => {
      if (Date.now() >= probeDeadline) {
        setProbePending(false);
        setProbeIssuedAt(null);
        setProbeDeadline(null);
        setProbeLauncherUrl(null);
        setProbeHandoffSlow(false);
        setError("The launcher measurement window expired. Start a new route check.");
        return;
      }
      try {
        const status = await api.latencyProbes();
        if (!active) return;
        setLatencyProbes(status);
        const completed = selectedRegions.every((region) => status.measurements.some((measurement) =>
          measurement.region === region
          && measurement.measuredAt !== undefined
          && new Date(measurement.measuredAt).getTime() >= probeIssuedAt - 1_000
        ));
        if (completed) {
          setProbePending(false);
          setProbeIssuedAt(null);
          setProbeDeadline(null);
          setProbeLauncherUrl(null);
          setProbeHandoffSlow(false);
          setError(null);
          setToast("Route measurements updated.");
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Could not refresh route measurements.");
      }
    };
    void update();
    const timer = window.setInterval(update, 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [probeDeadline, probeIssuedAt, probePending, selectedRegions]);

  useEffect(() => {
    if (!probePending || !probeLauncherUrl || probeHandoffSlow) return;
    const timer = window.setTimeout(() => setProbeHandoffSlow(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [probeHandoffSlow, probeLauncherUrl, probePending]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    let active = true;
    const update = () => refreshParty().catch((caught: unknown) => {
      if (active) setPartyError(caught instanceof Error ? caught.message : "Could not load party state.");
    });
    void update();
    const timer = window.setInterval(update, 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [auth?.authenticated, refreshParty]);

  useEffect(() => {
    if (data?.queue.phase !== "searching") return;
    const timer = window.setInterval(() => forceClock((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [data?.queue.phase]);

  useEffect(() => {
    const nextExpiry = latencyProbes?.measurements
      .map((measurement) => measurement.validUntil ? new Date(measurement.validUntil).getTime() : 0)
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > Date.now())
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => forceClock((value) => value + 1),
      Math.min(2_147_483_647, Math.max(0, nextExpiry - Date.now() + 25))
    );
    return () => window.clearTimeout(timer);
  }, [clock, latencyProbes]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    let stopped = false;
    const refreshPlatform = async () => {
      try {
        const platform = await api.platform();
        if (!stopped) setData((current) => current ? { ...current, platform } : current);
      } catch {
        // The realtime connection indicator already communicates outages. Keep
        // the last truthful snapshot instead of replacing it with placeholders.
      }
    };
    const timer = window.setInterval(() => void refreshPlatform(), 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [auth?.authenticated]);

  const queueElapsed = formatElapsed(data?.queue.joinedAt ?? null);
  const ratingWindow = useMemo(() => {
    if (data?.queue.phase !== "searching" || !data.queue.joinedAt)
      return data?.queue.ratingWindow ?? 50;
    const elapsed = Math.floor(
      (Date.now() - new Date(data.queue.joinedAt).getTime()) / 1000
    );
    return Math.min(200, 50 + Math.floor(elapsed / 60) * 25);
  }, [data?.queue.joinedAt, data?.queue.phase, data?.queue.ratingWindow, queueElapsed]);

  const ALL_MAPS = ["Mirage", "Inferno", "Nuke", "Overpass", "Vertigo", "Ancient", "Anubis"];

  const toggleMap = (map: string) => {
    if (data?.queue.phase !== "idle") return;
    setSelectedMaps((prev) =>
      prev.includes(map) ? prev.filter((m) => m !== map) : [...prev, map]
    );
  };

  const selectAllMaps = (all: boolean) => {
    if (data?.queue.phase !== "idle") return;
    setSelectedMaps(all ? ALL_MAPS : []);
  };

  const measureLatency = async () => {
    setError(null);
    setProbeHandoffSlow(false);
    setProbePending(true);
    try {
      const challenge = await api.createLatencyProbe(selectedRegions);
      const issuedAt = Date.now();
      setProbeIssuedAt(issuedAt);
      setProbeDeadline(new Date(challenge.expiresAt).getTime());
      setProbeLauncherUrl(challenge.launcherUrl);
      try {
        window.location.assign(challenge.launcherUrl);
      } catch {
        // Some browsers reject an unregistered custom protocol synchronously.
        // Keep the one-use link available so the player can install and retry it.
        setProbeHandoffSlow(true);
      }
    } catch (caught) {
      setProbePending(false);
      setProbeIssuedAt(null);
      setProbeDeadline(null);
      setProbeLauncherUrl(null);
      setProbeHandoffSlow(false);
      setError(caught instanceof Error ? caught.message : "Could not start route measurements.");
    }
  };

  const handleQueueAction = async () => {
    if (!data) return;
    setError(null);
    setRequestPending(true);
    try {
      if (data.queue.phase === "idle") {
        if (selectedMode === "competitive" && selectedMaps.length === 0) {
          throw new Error("Choose at least one map.");
        }
        patchQueue(await api.joinQueue(selectedRegions, selectedMaps, selectedMode));
        if (selectedMode === "deathmatch") {
          const platform = await api.platform();
          setData((current) => current ? { ...current, platform } : current);
        }
      } else if (data.queue.phase === "searching" || data.queue.phase === "ready-check") {
        patchQueue(await api.leaveQueue());
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Queue action failed.");
    } finally {
      setRequestPending(false);
    }
  };

  const acceptMatch = async (readyCheck: ReadyCheck) => {
    setAcceptPending(true);
    setError(null);
    try {
      const result = await api.acceptMatch(readyCheck.matchId);
      setData((prev) => (prev ? applyAcceptResult(prev, result) : prev));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not confirm match.");
    } finally {
      setAcceptPending(false);
    }
  };

  const banMap = async (matchId: string, map: string) => {
    setVetoPending(true);
    setError(null);
    try {
      const mapVeto = await api.banMap(matchId, map);
      setData((previous) => previous ? {
        ...previous,
        queue: { ...previous.queue, phase: "map-veto", playersFound: 10 },
        readyCheck: null,
        mapVeto,
        assignment: null
      } : previous);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record that map ban.");
    } finally {
      setVetoPending(false);
    }
  };

  const resetPrototype = async () => {
    setRequestPending(true);
    try {
      const bootstrap = await api.reset();
      setData(bootstrap);
      setSelectedMaps(bootstrap.queue.maps);
      setSelectedRegions(bootstrap.queue.regions);
      setMatchArchive(null);
      setMatchArchiveTotal(0);
      setToast("State reset.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reset.");
    } finally {
      setRequestPending(false);
    }
  };

  const handleLogout = async () => {
    await api.logout();
    setAuth({ authenticated: false });
    setData(null);
    setParty(null);
    setPartyInvites([]);
    setLatencyProbes(null);
    setProbePending(false);
    setVetoPending(false);
    setProbeIssuedAt(null);
    setProbeDeadline(null);
    setProbeLauncherUrl(null);
    setProbeHandoffSlow(false);
  };

  const completeOnboarding = async (displayName: string, region: string) => {
    setOnboardingPending(true);
    setOnboardingError(null);
    try {
      const player = await api.completeOnboarding(displayName, region);
      setData((current) => current ? { ...current, player } : current);
      setSelectedRegions([region]);
      setToast(`Welcome to B2G, ${displayName}.`);
    } catch (caught) {
      setOnboardingError(caught instanceof Error ? caught.message : "Could not save your in-game name.");
    } finally {
      setOnboardingPending(false);
    }
  };

  const saveAccountSettings = async (settings: AccountSettings & { region: string }) => {
    setSettingsPending(true);
    setError(null);
    try {
      const player = await api.updateAccountSettings(settings);
      setData((current) => current ? { ...current, player } : current);
      setSelectedRegions([settings.region]);
      setSelectedMode(settings.preferredMode);
      setToast("Account settings saved.");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save account settings.");
      return false;
    } finally {
      setSettingsPending(false);
    }
  };

  const runPartyAction = async (
    action: () => Promise<PartyState | null>,
    successMessage: string
  ) => {
    setPartyPending(true);
    setPartyError(null);
    try {
      setParty(await action());
      const pendingInvites = await api.partyInvites();
      setPartyInvites(pendingInvites.invites);
      setToast(successMessage);
    } catch (caught) {
      setPartyError(caught instanceof Error ? caught.message : "Party action failed.");
    } finally {
      setPartyPending(false);
    }
  };

  const inviteToParty = async (playerId: string) => {
    setPartyPending(true);
    setPartyError(null);
    try {
      await api.inviteToParty(playerId);
      setToast("Party invite sent.");
    } catch (caught) {
      setPartyError(caught instanceof Error ? caught.message : "Could not send the invite.");
    } finally {
      setPartyPending(false);
    }
  };

  const leaveParty = () => {
    if (!window.confirm("Leave this party? Leadership transfers automatically if members remain.")) return;
    void runPartyAction(async () => (await api.leaveParty()).party, "Left the party.");
  };

  const openProfile = async (playerId: string) => {
    setDetailPending("Loading player profile…");
    setLeaderboard(null);
    setMatchDetails(null);
    try {
      const loadedProfile = await api.playerProfile(playerId);
      if (activeView !== "profile") setProfileReturnView(activeView);
      setProfile(loadedProfile);
      setActiveView("profile");
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "Could not load that player.");
    } finally {
      setDetailPending(null);
    }
  };

  const openLeaderboard = async () => {
    if (!data) return;
    setDetailPending("Loading leaderboard…");
    setMatchDetails(null);
    try {
      const result = await api.leaderboard(data.player.region);
      setLeaderboard(result.entries);
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "Could not load the leaderboard.");
    } finally {
      setDetailPending(null);
    }
  };

  const openMatch = async (matchId: string) => {
    setDetailPending("Loading match evidence…");
    setLeaderboard(null);
    try {
      setMatchDetails(await api.matchDetails(matchId));
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "Could not load that match.");
    } finally {
      setDetailPending(null);
    }
  };

  const openReport = (match: MatchDetails, target: MatchPlayerDetails) => {
    setReportTarget({ matchId: match.id, playerId: target.playerId, displayName: target.displayName });
    setMatchDetails(null);
  };

  const submitReport = async (category: ReportCategory, description: string | null) => {
    if (!reportTarget) return;
    await api.createReport({
      reportedId: reportTarget.playerId,
      matchId: reportTarget.matchId,
      category,
      description
    });
    setReportTarget(null);
    setToast("Report submitted with match evidence.");
  };

  const openDiscipline = async () => {
    setDetailPending("Loading account standing…");
    try {
      setSanctions((await api.sanctions()).sanctions);
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "Could not load account standing.");
    } finally {
      setDetailPending(null);
    }
  };

  const openMatches = async () => {
    setProfile(null);
    setActiveView("matches");
    if (!data || matchArchive !== null || matchArchivePending) return;
    setMatchArchivePending(true);
    try {
      const result = await api.playerMatches(data.player.id);
      setMatchArchive(result.entries);
      setMatchArchiveTotal(result.total);
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "Could not load the match archive.");
      setMatchArchive(data.player.recentMatches);
      setMatchArchiveTotal(data.player.matchesPlayed);
    } finally {
      setMatchArchivePending(false);
    }
  };

  const loadMoreMatches = async () => {
    if (!data || !matchArchive || matchArchivePending) return;
    setMatchArchivePending(true);
    try {
      const result = await api.playerMatches(data.player.id, 50, matchArchive.length);
      setMatchArchive((current) => [...(current ?? []), ...result.entries]);
      setMatchArchiveTotal(result.total);
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "Could not load more matches.");
    } finally {
      setMatchArchivePending(false);
    }
  };

  // Loading auth check
  if (!authChecked) return <LoadingScreen />;

  // Not logged in
  if (!auth?.authenticated) {
    const errorCode = new URLSearchParams(window.location.search).get("error");
    return <LoginScreen errorCode={errorCode} />;
  }

  // Loading bootstrap data
  if (!data && !error) return <LoadingScreen />;

  if (!data) {
    return (
      <main className="fatal-state">
        <WifiOff size={24} />
        <h1>Matchroom unavailable</h1>
        <p>{error}</p>
        <button className="btn btn--primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </main>
    );
  }

  const { player, queue, platform } = data;
  if (launcherCode) return (
    <main className="login-shell">
      <div className="login-card"><BrandMark /><h1>B2G Launcher</h1><p>Connecting as {player.displayName}</p></div>
      <LauncherAuthorizationDialog
        userCode={normalizedLauncherCode ?? launcherCode}
        pending={launcherApprovalPending}
        approved={launcherApproved}
        error={validLauncherCode ? launcherApprovalError : "This code is invalid. Start again from the launcher."}
        onApprove={() => void approveLauncher()}
        onClose={clearLauncherAuthorization}
      />
    </main>
  );
  const searching = queue.phase === "searching";
  const assignment = queue.phase === "assigned" ? data.assignment : null;
  const lastFourDelta = player.recentMatches
    .slice(0, 4)
    .reduce((sum, m) => sum + m.ratingDelta, 0);

  return (
    <div className="app-shell">
      <a className="skip-link" href={activeView === "play" && legacyQueuePreview ? "#queue" : "#main-content"}>
        {activeView === "play" && legacyQueuePreview ? "Skip to queue" : "Skip to content"}
      </a>

      <header className="header">
        <div className="header-inner">
          <button className="logo" type="button" onClick={() => { setProfile(null); setActiveView("play"); }} aria-label="back2csgo Home">
            <BrandMark />
          </button>

          <nav className="nav" aria-label="Main">
            <button className={activeView === "play" ? "is-active" : ""} type="button" onClick={() => { setProfile(null); setActiveView("play"); }}>Home</button>
            <button className={activeView === "matches" ? "is-active" : ""} type="button" onClick={() => void openMatches()}>Matches</button>
            <button type="button" onClick={() => void openLeaderboard()}>
              <Trophy size={12} /> Ladder
            </button>
            <button type="button" onClick={() => setLauncherGuideOpen(true)}>
              <Terminal size={12} /> Launcher
            </button>
            {(player.platformRole === "moderator" || player.platformRole === "admin") && (
              <button type="button" onClick={() => setOperationsOpen(true)}>
                <Shield size={12} /> Ops
              </button>
            )}
          </nav>

          <div className="header-right">
            <ConnectionStatus
              live={connectionLive}
              onlinePlayers={platform.onlinePlayers}
              activeMatches={platform.activeMatches}
              season={platform.season}
              region={selectedRegions[0] ?? player.region}
            />
            <AccountMenu
              player={player}
              onProfile={() => void openProfile(player.id)}
              onSettings={() => { setProfile(null); setActiveView("account"); }}
              onLauncher={() => setLauncherGuideOpen(true)}
              onStanding={() => void openDiscipline()}
              onLogout={() => void handleLogout()}
            />
          </div>
        </div>
      </header>

      <main className="main" id="main-content" tabIndex={-1}>
        {activeView === "play" && !legacyQueuePreview && (
          <div className="launcher-first-layout">
            <LauncherHome
              player={player}
              queue={queue}
              platform={platform}
              onOpenGuide={() => setLauncherGuideOpen(true)}
              onOpenMatches={() => void openMatches()}
            />
            <MatchHistory matches={player.recentMatches} onMatch={(matchId) => void openMatch(matchId)} />
          </div>
        )}
        {activeView === "play" && legacyQueuePreview && <div className="content-grid">
          <QueuePanel
            queue={queue}
            assignment={assignment}
            selectedMaps={selectedMaps}
            selectedRegions={selectedRegions}
            selectedMode={selectedMode}
            searching={searching}
            queueElapsed={queueElapsed}
            ratingWindow={ratingWindow}
            requestPending={requestPending}
            latencyProbes={latencyProbes}
            probePending={probePending}
            probeHandoffSlow={probeHandoffSlow}
            probeLauncherUrl={probeLauncherUrl}
            error={error}
            queueDisabled={data.platform.controls?.queueEnabled === false}
            platformMessage={data.platform.controls?.userMessage ?? null}
            competitiveQueuePlayers={data.platform.competitiveQueuePlayers ?? queue.playersFound}
            deathmatchHumans={data.platform.deathmatchHumans ?? 0}
            deathmatchBots={data.platform.deathmatchBots ?? 0}
            deathmatchCapacity={data.platform.deathmatchCapacity ?? 0}
            onToggleMap={toggleMap}
            onSelectAllMaps={selectAllMaps}
            onRegionChange={(r) => setSelectedRegions([r])}
            onModeChange={(mode) => {
              setSelectedMode(mode);
              if (mode === "deathmatch") setSelectedMaps(ALL_MAPS);
            }}
            onQueueAction={handleQueueAction}
            onMeasureLatency={() => void measureLatency()}
            onRetryLauncher={() => {
              setError(null);
              setProbeHandoffSlow(false);
            }}
            onOpenLauncherGuide={() => setLauncherGuideOpen(true)}
            onReset={resetPrototype}
          />

          <PlayerSidebar
            player={player}
            lastFourDelta={lastFourDelta}
            party={party}
            partyInvites={partyInvites}
            partyPending={partyPending}
            partyError={partyError}
            onCreateParty={() => void runPartyAction(api.createParty, "Party created.")}
            onInvite={(playerId) => void inviteToParty(playerId)}
            onAcceptInvite={(inviteId) => void runPartyAction(
              () => api.acceptPartyInvite(inviteId),
              "Party joined. Mark ready when you are set."
            )}
            onPartyReady={(ready) => void runPartyAction(
              () => api.setPartyReady(ready),
              ready ? "Marked ready." : "Marked not ready."
            )}
            onTransferLeader={(playerId) => void runPartyAction(
              () => api.transferPartyLeader(playerId),
              "Party leadership transferred."
            )}
            onLeaveParty={leaveParty}
          />

          <MatchHistory matches={player.recentMatches} onMatch={(matchId) => void openMatch(matchId)} />
        </div>}
        {activeView === "matches" && (
          <MatchesPage
            matches={matchArchive ?? []}
            total={matchArchiveTotal}
            pending={matchArchivePending}
            onLoadMore={() => void loadMoreMatches()}
            onMatch={(matchId) => void openMatch(matchId)}
            title="All matches"
            description="Your complete B2G match archive, with Elo movement, performance, demos, and report evidence."
          />
        )}
        {activeView === "account" && (
          <AccountPage
            player={player}
            pending={settingsPending}
            onSave={saveAccountSettings}
            onOpenStanding={() => void openDiscipline()}
            onLoadInventory={api.cosmeticInventory}
            onRefreshInventory={api.refreshCosmeticInventory}
            onSaveLoadout={api.saveCosmeticLoadout}
          />
        )}
        {activeView === "profile" && profile && (
          <PlayerProfilePage
            profile={profile}
            currentPlayerId={player.id}
            onBack={() => { setProfile(null); setActiveView(profileReturnView); }}
            onMatch={(matchId) => void openMatch(matchId)}
            onSettings={() => { setProfile(null); setActiveView("account"); }}
            onStanding={() => void openDiscipline()}
            onInvite={(playerId) => void inviteToParty(playerId)}
          />
        )}
      </main>

      <footer className="footer">
        <span>
          B2G &middot; {platform.onlinePlayers.toLocaleString()} online &middot;{" "}
          {platform.activeMatches} matches &middot; {platform.season}
        </span>
        <nav className="footer-links" aria-label="Platform information">
          <a href="mailto:support@back2go.net">Support</a>
          <button type="button" onClick={() => setToast("Competitive rules are pending final playtest review. Contact support@back2go.net with questions.")}>Rules</button>
          <a href="/ready" target="_blank" rel="noreferrer">Status</a>
          <button type="button" onClick={() => setToast("Terms are pending final legal review before public launch.")}>Terms</button>
          <button type="button" onClick={() => setToast("The privacy policy is pending final legal review before public launch.")}>Privacy</button>
        </nav>
      </footer>

      {legacyQueuePreview && data.readyCheck && (
        <ReadyCheckDialog
          readyCheck={data.readyCheck}
          playerId={data.player.id}
          accepting={acceptPending}
          onAccept={() => acceptMatch(data.readyCheck!)}
          onDecline={handleQueueAction}
        />
      )}

      {legacyQueuePreview && data.mapVeto && (
        <MapVetoDialog
          veto={data.mapVeto}
          playerId={data.player.id}
          pending={vetoPending}
          onBan={(map) => void banMap(data.mapVeto!.matchId, map)}
        />
      )}

      {leaderboard && (
        <LeaderboardDialog
          entries={leaderboard}
          region={player.region}
          onClose={() => setLeaderboard(null)}
          onPlayer={(playerId) => void openProfile(playerId)}
        />
      )}

      {matchDetails && (
        <MatchDetailsDialog
          match={matchDetails}
          onClose={() => setMatchDetails(null)}
          onPlayer={(playerId) => void openProfile(playerId)}
          currentPlayerId={player.id}
          onReport={(target) => openReport(matchDetails, target)}
        />
      )}

      {reportTarget && (
        <ReportDialog
          displayName={reportTarget.displayName}
          onClose={() => setReportTarget(null)}
          onSubmit={submitReport}
        />
      )}

      {operationsOpen && (player.platformRole === "moderator" || player.platformRole === "admin") && (
        <OperationsDialog
          role={player.platformRole}
          onClose={() => setOperationsOpen(false)}
          onControlsChanged={(controls) => setData((current) => current ? {
            ...current,
            platform: { ...current.platform, controls }
          } : current)}
        />
      )}

      {launcherGuideOpen && (
        <LauncherGuideDialog
          onClose={() => setLauncherGuideOpen(false)}
          onMeasureLatency={() => void measureLatency()}
          latencyRequired={latencyProbes?.enabled ?? false}
        />
      )}

      {sanctions !== null && <DisciplineDialog sanctions={sanctions} onClose={() => setSanctions(null)} />}

      {detailPending && (
        <div className="detail-loading" role="status">
          <LoaderCircle size={16} /> {detailPending}
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <Check size={14} /> {toast}
        </div>
      )}
      {player.onboardingRequired && (
        <OnboardingDialog
          defaultRegion={player.region}
          pending={onboardingPending}
          error={onboardingError}
          onComplete={(displayName, region) => void completeOnboarding(displayName, region)}
        />
      )}
      {launcherCode && (
        <LauncherAuthorizationDialog
          userCode={normalizedLauncherCode ?? launcherCode}
          pending={launcherApprovalPending}
          approved={launcherApproved}
          error={validLauncherCode
            ? launcherApprovalError
            : "This launcher authorization link is malformed. Start pairing again from the launcher."}
          onApprove={() => void approveLauncher()}
          onClose={clearLauncherAuthorization}
        />
      )}
    </div>
  );
}
