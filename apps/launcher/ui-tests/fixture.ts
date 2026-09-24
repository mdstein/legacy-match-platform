import type { Page } from "@playwright/test";
export const me = "11111111-1111-4111-8111-111111111111";
export const other = "22222222-2222-4222-8222-222222222222";
export const offerId = "33333333-3333-4333-8333-333333333333";
export const matchId = "44444444-4444-4444-8444-444444444444";
export async function fixture(
  page: Page,
  options: Record<string, unknown> = {},
) {
  // Only the test harness supplies IPC fixtures. Production has no mock switch
  // and cannot connect a browser directly to credential-bearing APIs.
  await page.addInitScript(
    ({ me, other, offerId, matchId, options }) => {
      const w = window as any;
      const player = {
        id: me,
        displayName: "Playtest player",
        region: "NA Central",
        steamId: "76561198000000000",
        onboardingRequired: false,
        settings: {
          preferredMode: "competitive",
          allowPartyInvites: true,
          profileVisibility: "public",
          matchNotifications: true,
          productUpdates: false,
          reducedMotion: false,
        },
        rank: { name: "Master Guardian I", rating: 1248 },
      };
      const partner = {
        playerId: other,
        displayName: "Maple",
        tradeCode: "B2G-MAPLE",
        allowOffers: true,
        relationship: "friends",
        online: true,
        requestId: offerId,
      };
      const item = (
        id: string,
        owner: string,
        name: string,
        rarity: number,
        imageUrl: string,
      ) => ({
        assetId: id,
        ownerId: owner,
        ownershipGeneration: 1,
        itemKind: "cosmetic",
        definitionIndex: 8,
        weaponKey: "weapon_aug",
        displayName: name,
        imageUrl,
        paintIndex: 73,
        paintWear: 0.04,
        paintSeed: 24,
        quality: 4,
        rarity,
        origin: "container",
        statTrak: false,
        statTrakCount: null,
        customName: null,
        stickers: [],
        equipped: false,
        tradable: true,
        restriction: null,
        fingerprint: `fingerprint-${id}`,
      });
      const items = [
        item(
          "8000000000000000001",
          me,
          "AK-47 | Redline",
          4,
          "/trading-items/4e42427d9b8680067d77ffb4d42566e676020ba270c24e1379a7a75fff12c33e.png",
        ),
        {
          ...item(
            "8000000000000000002",
            me,
            "Glock-18 | Ironwork",
            3,
            "/trading-items/41f9973fc24d828de8ac454b1caaed1abf13fb507f5b6ca2a72772b694e2be46.png",
          ),
          statTrak: true,
          statTrakCount: 48,
        },
        item(
          "8000000000000000003",
          other,
          "AWP | Dragon Lore",
          6,
          "/trading-items/f579355d5bf788c2b0dcbc999aeac761351d387477b33a2c97a302eb81ad663b.png",
        ),
      ];
      const match = {
        id: matchId,
        map: "de_dust2",
        mode: "competitive",
        score: "16 : 11",
        outcome: "win",
        ratingDelta: 24,
        kills: 24,
        deaths: 15,
        assists: 6,
        adr: 92.4,
        playedAt: "2026-09-08T17:00:00Z",
      };
      const state = (w.fixture = {
        calls: [],
        delays: {},
        errors: {},
        player,
        partner,
        items,
        inventory: {
          status: "public", refreshedAt: "2026-09-08T17:00:00Z", nextRefreshAt: "2026-09-08T17:05:00Z",
          items: [
            { ...items[0], source: "b2g", iconUrl: items[0]!.imageUrl, selected: false, killEaterValue: null },
            { ...items[1], source: "steam", iconUrl: items[1]!.imageUrl, selected: true, killEaterValue: 48 },
            { ...items[0], assetId: "51000000001", source: "steam", selected: false,
              displayName: "★ Karambit | Gamma Doppler", rarity: 6, paintIndex: 572, paintWear: 0.02451576478779316, paintSeed: 205,
              iconUrl: "/trading-items/9d8ea3d3e7d50cb7f1b4348bffc4c224446f46899bc5bfdd67d249d1b3ddaf4b.png", killEaterValue: null }
          ]
        },
        pending: null,
        status: {
          version: "0.2.41",
          paired: true,
          gameOpen: false,
          profileIcon: "portrait",
          debugConsole: false,
          installation: {
            steamAvailable: true,
            ready: true,
            downloaded: 0,
            total: 0,
            detail: "CS:GO is installed and ready.",
          },
          session: {
            phase: "idle",
            message: "",
            pairing: false,
            pairCode: null,
            pairUrl: null,
            installing: false,
            preparing: false,
            installError: null,
            revision: 0,
          },
        },
        offer: {
          id: offerId,
          revision: 1,
          status: "pending",
          statusReason: null,
          senderId: other,
          participants: [
            {
              playerId: me,
              displayName: player.displayName,
              tradeCode: "B2G-TEST",
            },
            partner,
          ],
          items: [items[0], items[2]],
          itemCount: 2,
          changedAssetIds: [],
          message: "Trade for your next match?",
          createdAt: "2026-09-08T16:00:00Z",
          updatedAt: "2026-09-08T16:00:00Z",
          expiresAt: "2026-09-15T16:00:00Z",
          completedAt: null,
        },
        ...options,
      });
      if (options.signedOut) state.status.paired = false;
      if (options.fresh) {
        state.status.paired = false;
        state.status.installation.ready = false;
        state.status.installation.detail = "Install CS:GO through Steam to continue. B2G will finish setup automatically.";
      }
      if (options.onboarding) player.onboardingRequired = true;
      if (options.phase) state.status.session.phase = options.phase;
      const clone = (v: any) => JSON.parse(JSON.stringify(v));
      let callbackId = 1;
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      w.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: () => callbackId++,
        unregisterCallback: () => {},
        convertFileSrc: (s: string) => s,
        invoke: async (command: string, payload: any = {}) => {
          if (command !== "launcher_call")
            return command === "plugin:event|listen" ? callbackId++ : null;
          const { operation: op, args } = payload;
          state.calls.push({ op, args: clone(args) });
          let result: any = null;
          switch (op) {
            case "status":
              result = state.status;
              break;
            case "bootstrap":
              result = {
                player: state.player,
                gameProfile: {
                  competitiveRankId: 11,
                  competitiveWins: 37,
                  playerLevel: 19,
                  playerXp: 640,
                },
                platform: { onlinePlayers: 12, activeMatches: 2 },
                launcher: {
                  content: {
                    releaseVersion: "0.2.41",
                    news: {
                      title: "Welcome back to Counter-Strike.",
                      summary:
                        "Your matches, inventory and friends. Ready when you are.",
                    },
                    history: [
                      {
                        version: "0.2.41",
                        date: "2026-09-08",
                        changes: [
                          {
                            kind: "added",
                            text: "A new Tauri interface with smooth navigation.",
                          },
                          {
                            kind: "improved",
                            text: "Clearer trading, from your inbox to the final review.",
                          },
                          {
                            kind: "fixed",
                            text: "Reliable game status and controls at every window size.",
                          },
                        ],
                      },
                    ],
                  },
                },
              };
              break;
            case "account":
              result = state.player;
              break;
            case "inventory":
              result = state.inventory;
              break;
            case "inventory_refresh":
              if (!state.errors[op]) {
                state.inventory.refreshedAt = new Date().toISOString();
                state.inventory.nextRefreshAt = new Date(Date.now() + 300_000).toISOString();
              }
              result = state.inventory;
              break;
            case "play":
              state.status.session.phase = "starting";
              break;
            case "logout":
              state.status.paired = false;
              result = {};
              break;
            case "install":
              state.status.session.installing = true;
              break;
            case "stop_install":
              state.status.session.installing = false;
              break;
            case "pair":
              state.status.session.pairing = true;
              state.status.session.pairCode = "ABCD-1234";
              state.status.session.pairUrl =
                "https://play.back2go.net/launcher/connect";
              break;
            case "cancel_pair":
              state.status.session.pairing = false;
              state.status.session.pairCode = null;
              break;
            case "onboard":
              if (!state.errors[op]) Object.assign(state.player, args, { onboardingRequired: false });
              result = state.player;
              break;
            case "settings":
              Object.assign(state.player.settings, args.settings);
              state.player.region = args.settings.region;
              result = state.player;
              break;
            case "debug_console":
              state.status.debugConsole = args.visible;
              break;
            case "profile_icon":
              state.status.profileIcon = args.icon;
              break;
            case "matches":
              result = { entries: [match], total: 1 };
              break;
            case "match":
              result = {
                ...match,
                score: { alpha: 16, bravo: 11 },
                teams: {
                  alpha: [
                    {
                      playerId: me,
                      displayName: player.displayName,
                      kills: 24,
                      deaths: 15,
                      assists: 6,
                      adr: 92.4,
                      kast: 76,
                      ratingDelta: 24,
                      openingKills: 5,
                      openingDeaths: 3,
                      trades: 4,
                      clutches: 1,
                      flashAssists: 2,
                      utilityDamage: 126,
                    },
                  ],
                  bravo: [],
                  ffa: [],
                },
                demo: {
                  available: true,
                  analysisStatus: "ready",
                  warnings: [],
                },
              };
              break;
            case "friends":
              result = {
                entries: [state.partner],
                total: 1,
                friendCount: 1,
                incomingCount: 0,
                outgoingCount: 0,
              };
              break;
            case "profile":
              result = {
                player:
                  args.id === "me"
                    ? { ...state.player, playerId: me, relationship: "self" }
                    : state.partner,
                region: "NA Central",
                memberSince: "2026-08-12T00:00:00Z",
                level: 22,
                steamProfileUrl:
                  "https://steamcommunity.com/profiles/76561198000000000",
                rank: { name: "Master Guardian I", rating: 1248 },
                rankId: 11,
                stats: {
                  gamesPlayed: 62,
                  wins: 37,
                  losses: 24,
                  draws: 1,
                  kills: 1395,
                  deaths: 1025,
                  assists: 225,
                  winRate: 59.7,
                  kdRatio: 1.36,
                  averageAdr: 84.2,
                },
                matchTotal: 1,
                recentMatches: [match],
              };
              break;
            case "friend_action":
              result = state.friendResult || {};
              break;
            case "trade_overview":
              result = {
                enabled: true,
                player: {
                  playerId: me,
                  displayName: player.displayName,
                  tradeCode: "B2G-TEST",
                  allowOffers: true,
                },
                incomingCount: 1,
                unreadCount: 0,
                latestEventId: "1",
              };
              break;
            case "trade_players":
              result = [state.partner];
              break;
            case "trade_inventory":
              result = {
                items: state.items.filter(
                  (i: any) =>
                    i.ownerId === args.playerId &&
                    i.displayName
                      .toLowerCase()
                      .includes(args.query.toLowerCase()),
                ),
                nextCursor: null,
              };
              break;
            case "trade_offers":
              result = { offers: [state.offer], nextCursor: null };
              break;
            case "trade_offer":
              result = state.offer;
              break;
            case "trade_pending":
              result = state.pending;
              break;
            case "trade_mutate":
              if (state.errors[op])
                state.pending = {
                  playerId: me,
                  mutation: args.mutation,
                  requestId: offerId,
                };
              else {
                state.pending = null;
                state.offer.status =
                  args.mutation?.action === "respond" ? "completed" : "pending";
                result = state.offer;
              }
              break;
            case "trade_events":
              result = {
                events: [
                  {
                    id: "1",
                    kind: "completed",
                    createdAt: match.playedAt,
                    detail: { items: [{ before: state.items[1] }] },
                  },
                ],
              };
              break;
          }
          result = clone(result);
          if (state.delays[op])
            await new Promise((r) => setTimeout(r, state.delays[op]));
          if (state.errors[op]) throw state.errors[op];
          return result;
        },
      };
    },
    { me, other, offerId, matchId, options },
  );
  // Load the actual shipping item artwork without an external network dependency.
  await page.route("https://play.back2go.net/trading-items/**", (route) =>
    route.fulfill({
      path: `../web/public/trading-items/${new URL(route.request().url()).pathname.split("/").pop()}`,
      contentType: "image/png",
    }),
  );
  await page.goto("/");
  await page.locator(".play-button").waitFor();
}
export async function refresh(page: Page) {
  await page.getByRole("button", { name: "Refresh current data" }).click();
}
