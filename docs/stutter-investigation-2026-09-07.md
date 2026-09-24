# Stutter after bulk case opening

Read-only investigation, approximately 07:02–07:07 UTC. No game restart,
configuration change, inventory mutation, or release deployment was performed.

## Observations

- Active match `9909be37-e2ed-44ed-b205-4bff5f640575`, node 0.1.26, launcher
  0.2.27. SRCDS started at approximately 06:58 UTC, after the observed case
  openings ended around 06:50 UTC. This is a fresh server process; the client
  process has remained open since approximately 06:17 UTC.
- No unfinished command backlog was observed. Inventory commands completed on
  their first attempt. One announcement failed when the previous match drained
  at 06:28; it is historical, not ongoing retry traffic. Database sessions were
  idle except the diagnostic query, with no observed lock contention.
- Inventory currently contains 170 active B2G cosmetics plus two imported Steam
  items, and no active cases/keys. The client confirms 172 current owned items.
- Twelve ICMP probes from the user's machine returned 24–26 ms with zero loss.
  Server `net_status` also reported zero inbound/outbound loss at sampling time.
  These short samples do not exclude intermittent UDP/network problems.
- The occupied server reports one human and 14 bots in `status` (its GOTV
  presence must be distinguished from playable bots). The `stats` samples report
  14 players. Server simulation work was commonly about 3.3–6.5 ms, with one
  extended-sample observation at 8.61 ms; a 128-tick interval is 7.8125 ms.
  Reported frame rates and timing variation were uneven. These are sampled
  engine statistics, not an individual-frame trace or proof of a specific cause.
- The server has four logical processors and about 2.6 GiB available memory.
  Three process samples showed SRCDS using 12/36/66 percent of one processor;
  processor queue length was zero. Sustained machine-wide CPU/memory exhaustion
  was not observed; main-thread stalls/host scheduling remain possible.
- The user's saved CS:GO configuration sets `cl_cmdrate 64`, `cl_updaterate 64`,
  and `rate 196608`. Server network status reported approximately 64.5 outgoing
  packets/s in one sample. The server permits 64–128 updates. This is a separate
  responsiveness limitation, not evidence of an unboxing-triggered regression.
- The same local CS:GO process has about 2.7 GiB private memory / 2.4 GiB resident
  memory after the extended unboxing session. Windows has about 34 GiB available
  and minimal sampled disk paging. There is no before/after memory baseline or
  allocation trace, so a leak or memory-pressure cause is not established.
- Live client logs repeatedly show direct StatTrak application followed by a
  full manifest reread with `removed=0 added=0 changed=0`. The launcher still
  fetches/parses the complete inventory when the database revision advances.
  This is confirmed redundant work, but no frame-time correlation was captured.
- Every launcher profile-state packet triggers matchmaking hello, rank, and
  matchmaking-status messages in `ClientGC::HandleLauncherBridgeMessage`, even
  when profile fields are unchanged. Client logs show accompanying rejected
  store-data requests. This is another optimization candidate, not a proven
  explanation for the reported severity.

## Interpretation and next discriminating checks

User follow-up: fully restarting the game eliminated the stutter completely.
This strongly favors client session accumulation or state over inventory size
alone or sustained dedicated-server overload. The inventory was retained. It
does not yet distinguish preview/resource retention, UI state, or repeated
inventory/profile handling; no specific leak has been measured. The 64-rate
configuration is a separate tuning issue and is not established as the cause
of the resolved stutter.

The evidence does not support an ongoing 390-case command backlog or server
memory accumulation from the openings. Server timing jitter is measurable, and
inventory/profile synchronization performs avoidable client work. Attribution
requires distinguishing camera/FPS stalls from smooth-camera rubber-banding.

1. Compare a user-initiated fresh client session in the same server, retaining
   the inventory. Observe client FPS/frame times and server timing simultaneously.
   This tests accumulated preview/UI state without deleting rewards.
2. Capture a frame/thread trace during a reported hitch. Correlate it with
   inventory refreshes, server simulation time, and game-network metrics.
3. Independently remove duplicate unchanged profile publications and optimize
   confirmed-counter recovery without losing authoritative reconciliation,
   mid-match inventory updates, service medals, or queue state.
4. Validate 128-rate client defaults as a separate change. Keep bots, 128 tick,
   GOTV, anti-cheat, and progression enabled when comparing server performance.

Evidence is saved under `.artifacts/diagnostics/stutter-20260907-*.log`;
diagnostic SQL, PowerShell, and RCON scripts are in the same directory.

## Unlock then Escape clarification and 0.2.28 fix

The owner clarified that approximately 95% of the openings were interrupted by
pressing Escape / closing the animation after clicking Unlock. This is the
stock case popup close path, not a separate quick-open button or API mode.

The exact final-2023 Panorama scripts have incomplete explicit cleanup on that
path. The case popup schedules model, scroll, sound, material-precache and
reward-preview callbacks, but its close function cancels only selected handles.
It also registers global events without explicitly unregistering them at close.
The accompanying async action frame retains its response handler and timeout.
Cleanup consequently depends on when the host destroys the panel/context.

Launcher 0.2.28 embeds a GC patch that gives both scripts a shared popup lifetime:
close cancels tracked timers, unregisters event handlers, and makes already
queued callbacks harmless. Either close path disposes both scripts' work, and
duplicate close is safe. Normal reveals and the intended deferred tournament
journal navigation remain. The authoritative Unlock request is not cancelled;
the existing GC/API transaction still consumes the case and grants its reward.
No server code, network rate, inventory/profile state, or user process was
changed for this fix.

The test executes the actual archive scripts in a mocked host that deliberately
retains closed panels. The original scripts retain 80 event handlers after 20
Unlock/Escape cycles and perform subsequent work on closed panels. The patch
passes 390 cycles with zero timers or handlers remaining after close and no
late UI work or unsolicited reward previews. Twenty normal reveals, Escape and
action-close at six animation phases, duplicate closes, queued callback races,
and a timeout followed by a late result also pass. Native archive validation
against the installed 4,704,521-byte `code.pbin` and all eight CTests pass.

These are script-lifecycle results, not native engine heap/FPS measurements.
They establish and repair an explicit cleanup defect but do not prove that it
accounts for every observed hitch. The remaining acceptance check is a real
long-session opening/Deathmatch soak on 0.2.28 with frame-time observations,
reward persistence checks, and no intervening client restart. See
[the 0.2.28 release checkpoint](playtest-0.2.28.md).
