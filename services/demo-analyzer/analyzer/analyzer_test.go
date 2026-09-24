package analyzer

import (
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v3/pkg/demoinfocs/common"
)

func TestFinishedPlayersComputesStableStatsAndOrder(t *testing.T) {
	stats := newAccumulator()
	stats.players["76561198000000002"] = &PlayerStats{
		SteamID: "76561198000000002", Damage: 1176, RoundsPlayed: 28, KASTRounds: 21,
	}
	stats.players["76561198000000001"] = &PlayerStats{
		SteamID: "76561198000000001", Damage: 100, RoundsPlayed: 3, KASTRounds: 2,
	}
	players := stats.finishedPlayers()
	if len(players) != 2 || players[0].SteamID != "76561198000000001" {
		t.Fatalf("players were not sorted: %#v", players)
	}
	if players[1].ADR != 42 || players[1].KAST != 75 {
		t.Fatalf("unexpected derived stats: %#v", players[1])
	}
}

func TestTeamNamesAndRounding(t *testing.T) {
	if teamName(common.TeamTerrorists) != "terrorists" {
		t.Fatal("terrorist team name changed")
	}
	if teamName(common.TeamCounterTerrorists) != "counter-terrorists" {
		t.Fatal("counter-terrorist team name changed")
	}
	if roundFloat(2.345, 2) != 2.35 {
		t.Fatalf("unexpected rounding: %v", roundFloat(2.345, 2))
	}
}
