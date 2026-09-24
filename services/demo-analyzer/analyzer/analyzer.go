package analyzer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"time"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v3/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v3/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v3/pkg/demoinfocs/events"
)

const (
	SchemaVersion   = 1
	AnalyzerName    = "aftertick-demoinfocs-csgo"
	AnalyzerVersion = "0.1.0-demoinfocs-v3.3.0"
)

type Source struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

type Header struct {
	Filestamp       string  `json:"filestamp"`
	Protocol        int     `json:"protocol"`
	NetworkProtocol int     `json:"networkProtocol"`
	ServerName      string  `json:"serverName"`
	ClientName      string  `json:"clientName"`
	MapName         string  `json:"mapName"`
	GameDirectory   string  `json:"gameDirectory"`
	PlaybackSeconds float64 `json:"playbackSeconds"`
	PlaybackTicks   int     `json:"playbackTicks"`
	PlaybackFrames  int     `json:"playbackFrames"`
	TickRate        float64 `json:"tickRate"`
}

type PlayerStats struct {
	SteamID       string  `json:"steamId"`
	Name          string  `json:"name"`
	Kills         int     `json:"kills"`
	Deaths        int     `json:"deaths"`
	Assists       int     `json:"assists"`
	Damage        int     `json:"damage"`
	ADR           float64 `json:"adr"`
	KAST          float64 `json:"kast"`
	OpeningKills  int     `json:"openingKills"`
	OpeningDeaths int     `json:"openingDeaths"`
	Trades        int     `json:"trades"`
	Clutches      int     `json:"clutches"`
	FlashAssists  int     `json:"flashAssists"`
	UtilityDamage int     `json:"utilityDamage"`
	RoundsPlayed  int     `json:"roundsPlayed"`
	Headshots     int     `json:"headshots"`
	KASTRounds    int     `json:"kastRounds"`
}

type Round struct {
	Number       int    `json:"number"`
	Winner       string `json:"winner"`
	Reason       string `json:"reason"`
	TScore       int    `json:"tScore"`
	CTScore      int    `json:"ctScore"`
	StartTick    int    `json:"startTick"`
	EndTick      int    `json:"endTick"`
	OpeningKill  string `json:"openingKill,omitempty"`
	OpeningDeath string `json:"openingDeath,omitempty"`
}

type Quality struct {
	ParseComplete bool           `json:"parseComplete"`
	Warnings      []string       `json:"warnings"`
	EventCounts   map[string]int `json:"eventCounts"`
	Rounds        int            `json:"rounds"`
	Players       int            `json:"players"`
}

type Analysis struct {
	SchemaVersion   int           `json:"schemaVersion"`
	Analyzer        string        `json:"analyzer"`
	AnalyzerVersion string        `json:"analyzerVersion"`
	Source          Source        `json:"source"`
	Header          Header        `json:"header"`
	Players         []PlayerStats `json:"players"`
	Rounds          []Round       `json:"rounds"`
	Quality         Quality       `json:"quality"`
}

type accumulator struct {
	players        map[string]*PlayerStats
	rounds         []Round
	eventCounts    map[string]int
	roundNumber    int
	roundStartTick int
	openingKill    string
	openingDeath   string
	contributed    map[string]bool
	traded         map[string]bool
	clutchPlayer   string
	clutchTeam     common.Team
	lastKill       *killContext
}

type killContext struct {
	killer     string
	victim     string
	victimTeam common.Team
	at         time.Duration
}

func newAccumulator() *accumulator {
	return &accumulator{
		players:     make(map[string]*PlayerStats),
		rounds:      make([]Round, 0),
		eventCounts: make(map[string]int),
		contributed: make(map[string]bool),
		traded:      make(map[string]bool),
	}
}

func AnalyzeFile(path string) (result Analysis, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("demo parser panic: %v", recovered)
		}
	}()

	source, err := inspectSource(path)
	if err != nil {
		return Analysis{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return Analysis{}, fmt.Errorf("open demo: %w", err)
	}
	defer file.Close()

	parser := demoinfocs.NewParser(file)
	defer parser.Close()
	header, err := parser.ParseHeader()
	if err != nil {
		return Analysis{}, fmt.Errorf("parse demo header: %w", err)
	}
	stats := newAccumulator()

	parser.RegisterEventHandler(func(event events.RoundStart) {
		stats.eventCounts["round.start"]++
		stats.roundNumber++
		stats.roundStartTick = parser.GameState().IngameTick()
		stats.openingKill = ""
		stats.openingDeath = ""
		stats.contributed = make(map[string]bool)
		stats.traded = make(map[string]bool)
		stats.clutchPlayer = ""
		stats.clutchTeam = common.TeamUnassigned
		stats.lastKill = nil
	})
	parser.RegisterEventHandler(func(event events.PlayerHurt) {
		stats.eventCounts["player.hurt"]++
		if event.Attacker == nil || event.Player == nil || event.Attacker == event.Player {
			return
		}
		if event.Attacker.Team == event.Player.Team {
			return
		}
		attacker := stats.player(event.Attacker)
		if attacker == nil {
			return
		}
		attacker.Damage += event.HealthDamageTaken
		if event.Weapon != nil && event.Weapon.Type.Class() == common.EqClassGrenade {
			attacker.UtilityDamage += event.HealthDamageTaken
		}
	})
	parser.RegisterEventHandler(func(event events.Kill) {
		stats.eventCounts["player.kill"]++
		victim := stats.player(event.Victim)
		killer := stats.player(event.Killer)
		assister := stats.player(event.Assister)
		if victim != nil {
			victim.Deaths++
		}
		enemyKill := event.Killer != nil && event.Victim != nil && event.Killer != event.Victim && event.Killer.Team != event.Victim.Team
		if enemyKill && killer != nil {
			killer.Kills++
			stats.contributed[killer.SteamID] = true
			if event.IsHeadshot {
				killer.Headshots++
			}
			if stats.openingKill == "" {
				stats.openingKill = killer.SteamID
				stats.openingDeath = victim.SteamID
				killer.OpeningKills++
				victim.OpeningDeaths++
			}
			if stats.lastKill != nil && stats.lastKill.killer == victim.SteamID &&
				event.Killer.Team == stats.lastKill.victimTeam &&
				parser.CurrentTime()-stats.lastKill.at <= 5*time.Second {
				killer.Trades++
				stats.traded[stats.lastKill.victim] = true
			}
			stats.lastKill = &killContext{
				killer: killer.SteamID, victim: victim.SteamID,
				victimTeam: event.Victim.Team, at: parser.CurrentTime(),
			}
			stats.detectClutch(parser, event.Killer)
		}
		if assister != nil && event.Assister != event.Killer && event.Assister != event.Victim {
			assister.Assists++
			stats.contributed[assister.SteamID] = true
			if event.AssistedFlash {
				assister.FlashAssists++
			}
		}
	})
	parser.RegisterEventHandler(func(event events.RoundEnd) {
		stats.eventCounts["round.end"]++
		stats.finishRound(parser, event)
	})

	parseErr := parser.ParseToEnd()
	complete := parseErr == nil
	if parseErr != nil && !errors.Is(parseErr, demoinfocs.ErrUnexpectedEndOfDemo) {
		return Analysis{}, fmt.Errorf("parse demo: %w", parseErr)
	}

	players := stats.finishedPlayers()
	warnings := make([]string, 0)
	if parseErr != nil {
		warnings = append(warnings, "unexpected_end_of_demo")
	}
	if header.Filestamp != "HL2DEMO" {
		warnings = append(warnings, "unexpected_filestamp")
	}
	if header.PlaybackTicks <= 0 || header.PlaybackFrames <= 0 {
		warnings = append(warnings, "empty_or_header_only_demo")
	}
	if len(stats.rounds) == 0 {
		warnings = append(warnings, "no_completed_rounds")
	}
	if len(players) == 0 {
		warnings = append(warnings, "no_rostered_players_observed")
	}
	return Analysis{
		SchemaVersion:   SchemaVersion,
		Analyzer:        AnalyzerName,
		AnalyzerVersion: AnalyzerVersion,
		Source:          source,
		Header: Header{
			Filestamp:       header.Filestamp,
			Protocol:        header.Protocol,
			NetworkProtocol: header.NetworkProtocol,
			ServerName:      header.ServerName,
			ClientName:      header.ClientName,
			MapName:         header.MapName,
			GameDirectory:   header.GameDirectory,
			PlaybackSeconds: roundFloat(header.PlaybackTime.Seconds(), 3),
			PlaybackTicks:   header.PlaybackTicks,
			PlaybackFrames:  header.PlaybackFrames,
			TickRate:        roundFloat(parser.TickRate(), 3),
		},
		Players: players,
		Rounds:  stats.rounds,
		Quality: Quality{
			ParseComplete: complete,
			Warnings:      warnings,
			EventCounts:   stats.eventCounts,
			Rounds:        len(stats.rounds),
			Players:       len(players),
		},
	}, nil
}

func inspectSource(path string) (Source, error) {
	file, err := os.Open(path)
	if err != nil {
		return Source{}, fmt.Errorf("open demo for checksum: %w", err)
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return Source{}, fmt.Errorf("checksum demo: %w", err)
	}
	return Source{Path: path, SizeBytes: size, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (stats *accumulator) player(player *common.Player) *PlayerStats {
	if player == nil || player.SteamID64 == 0 || player.IsBot {
		return nil
	}
	steamID := strconv.FormatUint(player.SteamID64, 10)
	current := stats.players[steamID]
	if current == nil {
		current = &PlayerStats{SteamID: steamID, Name: player.Name}
		stats.players[steamID] = current
	} else if player.Name != "" {
		current.Name = player.Name
	}
	return current
}

func (stats *accumulator) detectClutch(parser demoinfocs.Parser, killer *common.Player) {
	if killer == nil || stats.clutchPlayer != "" {
		return
	}
	aliveTeam := 0
	aliveEnemy := 0
	for _, player := range parser.GameState().Participants().Playing() {
		if player == nil || player.IsBot || !player.IsAlive() {
			continue
		}
		if player.Team == killer.Team {
			aliveTeam++
		} else {
			aliveEnemy++
		}
	}
	if aliveTeam == 1 && aliveEnemy >= 1 {
		if value := stats.player(killer); value != nil {
			stats.clutchPlayer = value.SteamID
			stats.clutchTeam = killer.Team
		}
	}
}

func (stats *accumulator) finishRound(parser demoinfocs.Parser, event events.RoundEnd) {
	for _, player := range parser.GameState().Participants().Playing() {
		value := stats.player(player)
		if value == nil {
			continue
		}
		value.RoundsPlayed++
		if stats.contributed[value.SteamID] || stats.traded[value.SteamID] || player.IsAlive() {
			value.KASTRounds++
		}
	}
	if stats.clutchPlayer != "" && event.Winner == stats.clutchTeam {
		if player := stats.players[stats.clutchPlayer]; player != nil {
			player.Clutches++
		}
	}
	tScore := parser.GameState().TeamTerrorists().Score()
	ctScore := parser.GameState().TeamCounterTerrorists().Score()
	if event.Winner == common.TeamTerrorists {
		tScore++
	} else if event.Winner == common.TeamCounterTerrorists {
		ctScore++
	}
	stats.rounds = append(stats.rounds, Round{
		Number:       stats.roundNumber,
		Winner:       teamName(event.Winner),
		Reason:       roundEndReasonName(event.Reason),
		TScore:       tScore,
		CTScore:      ctScore,
		StartTick:    stats.roundStartTick,
		EndTick:      parser.GameState().IngameTick(),
		OpeningKill:  stats.openingKill,
		OpeningDeath: stats.openingDeath,
	})
}

func (stats *accumulator) finishedPlayers() []PlayerStats {
	players := make([]PlayerStats, 0, len(stats.players))
	for _, player := range stats.players {
		if player.RoundsPlayed > 0 {
			player.ADR = roundFloat(float64(player.Damage)/float64(player.RoundsPlayed), 1)
			player.KAST = roundFloat(float64(player.KASTRounds)*100/float64(player.RoundsPlayed), 1)
		}
		players = append(players, *player)
	}
	sort.Slice(players, func(i, j int) bool { return players[i].SteamID < players[j].SteamID })
	return players
}

func teamName(team common.Team) string {
	switch team {
	case common.TeamTerrorists:
		return "terrorists"
	case common.TeamCounterTerrorists:
		return "counter-terrorists"
	case common.TeamSpectators:
		return "draw"
	default:
		return "unknown"
	}
}

func roundEndReasonName(reason events.RoundEndReason) string {
	switch reason {
	case events.RoundEndReasonTargetBombed:
		return "target_bombed"
	case events.RoundEndReasonBombDefused:
		return "bomb_defused"
	case events.RoundEndReasonCTWin:
		return "counter_terrorists_win"
	case events.RoundEndReasonTerroristsWin:
		return "terrorists_win"
	case events.RoundEndReasonDraw:
		return "draw"
	case events.RoundEndReasonTargetSaved:
		return "target_saved"
	case events.RoundEndReasonTerroristsSurrender:
		return "terrorists_surrender"
	case events.RoundEndReasonCTSurrender:
		return "counter_terrorists_surrender"
	default:
		return fmt.Sprintf("reason_%d", reason)
	}
}

func roundFloat(value float64, places int) float64 {
	power := 1.0
	for index := 0; index < places; index++ {
		power *= 10
	}
	return float64(int64(value*power+0.5)) / power
}
