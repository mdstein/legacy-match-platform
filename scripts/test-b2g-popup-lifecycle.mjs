import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

// Execute the actual CRC-pinned 2023 scripts, not a rewritten approximation.
// The host deliberately retains closed panels until later GC; explicit teardown
// must work independently of when Panorama releases its native panel/context.
const archivePath = process.env.B2G_FINAL_CODE_PBIN
  ?? "C:/Program Files (x86)/Steam/steamapps/common/csgo legacy/csgo/panorama/code.pbin";
const original = readFileSync(archivePath);
const baseline = process.argv.includes("--baseline");
let archive = original;
if (!baseline) {
  const output = resolve(".artifacts/diagnostics/popup-lifecycle-patched.pbin");
  const patcher = resolve("vendor/csgo-gc/build-b2g/csgo_gc/panorama_patch_tests.exe");
  const result = spawnSync(patcher, [archivePath, output], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  archive = readFileSync(output);
}
function entry(bytes, name) {
  for (let offset = 0; offset + 30 < bytes.length; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if (bytes.toString("utf8", offset + 30, offset + 30 + nameLength) !== name) continue;
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const begin = offset + 30 + nameLength + extraLength;
    return bytes.toString("utf8", begin, begin + bytes.readUInt32LE(offset + 22));
  }
  throw new Error(`Missing archive entry: ${name}`);
}
const asyncScript = entry(archive, "panorama\\scripts\\popups\\popup_inspect_async-bar.js");
const caseScript = entry(archive, "panorama\\scripts\\popups\\popup_capability_decodable.js");

class Host {
  now = 0;
  next = 1;
  timers = new Map();
  events = new Map();
  previews = [];
  lateUiWork = 0;
  useTools = 0;
  callbackCalls = 0;
  dispatch(name, ...args) {
    for (const event of [...this.events.values()]) {
      if (event.name !== name) continue;
      this.callbackCalls++;
      event.callback(...args);
    }
  }
  advance(seconds) {
    const until = this.now + seconds;
    let steps = 0;
    while (true) {
      const next = [...this.timers.entries()].filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++steps < 200_000, "Unbounded animation/timer loop");
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = until;
  }
  popup() {
    const host = this;
    const root = { closed: false, valid: true, nodes: new Map(), attributes: new Map([
      ["key-and-case", "0,8000000000000009000"], ["asyncworktype", "decodeable"],
    ]) };
    function panel(id) {
      if (root.nodes.has(id)) return root.nodes.get(id);
      const classes = new Set(id === "popup" ? ["PopupPanel"] : []);
      if (id === "DecodableItemsScroll") classes.add("hidden");
      const handlers = new Map();
      const value = {
        id, style: {}, visible: true, enabled: true, contentwidth: 100, actualxoffset: 0,
        IsValid: () => root.valid,
        GetParent: () => id === "popup" ? null : panel("popup"),
        FindChildInLayoutFile: panel, FindChildTraverse: panel,
        GetAttributeString: (key, fallback) => root.attributes.get(key) ?? fallback,
        SetAttributeString: (key, v) => root.attributes.set(key, v),
        BHasClass: (c) => classes.has(c),
        AddClass: (c) => { if (root.closed) host.lateUiWork++; classes.add(c); },
        RemoveClass: (c) => { if (root.closed) host.lateUiWork++; classes.delete(c); },
        SetHasClass: (c, on) => on ? classes.add(c) : classes.delete(c),
        SetPanelEvent: (event, callback) => handlers.set(event, callback),
        activate: () => handlers.get("onactivate")?.(),
        PlaySequence: () => { if (root.closed) host.lateUiWork++; },
        SetCameraPreset() {}, SetDialogVariable() {}, SetDialogVariableInt() {},
        SetImage() {}, BLoadLayoutSnippet() {}, TriggerClass() {}, ScrollToFitRegion() {},
      };
      root.nodes.set(id, value);
      return value;
    }
    const noop = () => {};
    const $ = Object.assign((id) => panel(id.replace(/^#/, "")), {
      GetContextPanel: () => panel("popup"),
      Schedule: (delay, callback) => {
        const handle = host.next++;
        host.timers.set(handle, { at: host.now + delay, callback });
        return handle;
      },
      CancelScheduled: (handle) => host.timers.delete(handle),
      RegisterForUnhandledEvent: (name, callback) => {
        const handle = host.next++;
        host.events.set(handle, { name, callback });
        return handle;
      },
      UnregisterForUnhandledEvent: (name, handle) => {
        assert.equal(host.events.get(handle)?.name, name, "Wrong event registration removed");
        host.events.delete(handle);
      },
      DispatchEvent: (name, ...args) => {
        if (name === "UIPopupButtonClicked") root.closed = true;
        if (name === "InventoryItemPreview") host.previews.push(args[0]);
        host.dispatch(name, ...args);
      },
      CreatePanel: (_type, _parent, id) => panel(id), Localize: (s) => s,
    });
    const context = vm.createContext({ $, console,
      InventoryAPI: {
        IsItemInfoValid: () => true, IsValidItemID: (id) => !!id,
        GetAssociatedItemsCount: () => 0, GetDecodeableRestriction: () => "",
        GetLootListItemsCount: () => 2, GetItemRarity: () => 4,
        IsItemUnusual: () => false,
        UseTool: () => host.useTools++, StopItemPreviewMusic: noop,
        AcknowledgeNewItembyItemID: noop, SetItemSessionPropertyValue: noop,
        PrecacheCustomMaterials: () => { if (root.closed) host.lateUiWork++; },
      },
      ItemInfo: { GetLootListCount: () => 0, GetSlot: () => "crate", GetName: () => "case",
        GetRarityColor: () => "#8847ff", GetItemName: () => "reward",
        GetItemDefinitionName: () => "crate", ItemMatchDefName: () => false,
        ItemDefinitionNameSubstrMatch: () => false },
      CapabiityHeader: { Init: noop },
      InspectModelImage: { Init: () => panel("InspectItemImage").AddClass("hidden") },
      InpsectPurchaseBar: { Init: () => panel("PopUpInspectPurchaseBar").AddClass("hidden"), ClosePopup: noop },
      UiToolkitAPI: { ShowGenericPopupOk: noop, ShowCustomLayoutPopupParameters: noop },
    });
    vm.runInContext(asyncScript, context, { filename: "popup_inspect_async-bar.js" });
    vm.runInContext(caseScript, context, { filename: "popup_capability_decodable.js" });
    context.CapabilityDecodable.Init();
    return {
      root, context, unlock: () => panel("AsyncItemWorkAcceptConfirm").activate(),
      escape: () => context.CapabilityDecodable.ClosePopUp(),
      closeAction: () => context.InspectAsyncActionBar.OnEventToClose(),
      result: (id) => host.dispatch("PanoramaComponent_Inventory_ItemCustomizationNotification", 0, "crate_unlock", id),
    };
  }
}

const quick = new Host();
let peakTimers = 0;
let peakEvents = 0;
const quickCount = baseline ? 20 : 390;
for (let i = 0; i < quickCount; i++) {
  const popup = quick.popup();
  popup.unlock();
  quick.advance(0.05);
  popup.escape();
  popup.result(String(8000000 + i)); // authoritative result can arrive after Escape
  peakTimers = Math.max(peakTimers, quick.timers.size);
  peakEvents = Math.max(peakEvents, quick.events.size);
  if (!baseline) {
    assert.equal(quick.timers.size, 0, `Timers survived Escape at opening ${i}`);
    assert.equal(quick.events.size, 0, `Callbacks survived Escape at opening ${i}`);
  }
  // Native popup collection may be delayed. No closed popup may process work.
  quick.advance(0.1);
}
quick.advance(20);
console.log(JSON.stringify({ mode: baseline ? "baseline" : "patched", openings: quickCount,
  useTools: quick.useTools, peakTimersAfterClose: peakTimers, peakEventsAfterClose: peakEvents,
  remainingTimers: quick.timers.size, remainingEvents: quick.events.size,
  lateUiWork: quick.lateUiWork, unsolicitedPreviews: quick.previews.length,
  callbackCalls: quick.callbackCalls }));
if (!baseline) {
  assert.equal(quick.useTools, 390, "Escape must not cancel/repeat authoritative opening");
  assert.equal(quick.lateUiWork, 0);
  assert.equal(quick.previews.length, 0, "Late rewards must not reopen a closed popup");
  const normal = new Host();
  for (let i = 0; i < 20; i++) {
    const popup = normal.popup();
    popup.unlock();
    normal.advance(0.2);
    popup.result(String(9000000 + i));
    normal.advance(10);
    assert.equal(normal.previews.length, i + 1, "Normal opening must reveal exactly once");
    assert.equal(normal.timers.size, 0);
    assert.equal(normal.events.size, 0);
  }
  console.log("Normal opening/reveal preserved across 20 cycles.");
  for (const phase of [0, 0.05, 1.2, 2.35, 3.5, 8.2]) {
    for (const close of ["escape", "closeAction"]) {
      const host = new Host();
      const popup = host.popup();
      popup.unlock();
      popup.result("123456789");
      host.advance(phase);
      const queuedCallbacks = [...host.events.values()].map((e) => e.callback);
      const queuedTimers = [...host.timers.values()].map((t) => t.callback);
      popup[close]();
      popup[close](); // reentrant/double close is safe
      for (const callback of queuedCallbacks) callback(0, "crate_unlock", "123456789");
      for (const callback of queuedTimers) callback();
      host.advance(20);
      assert.equal(host.timers.size, 0, `Timer at phase ${phase}, ${close}`);
      assert.equal(host.events.size, 0, `Handler at phase ${phase}, ${close}`);
      assert.equal(host.previews.length, 0, `Stale preview at phase ${phase}, ${close}`);
      assert.equal(host.lateUiWork, 0, `Stale work at phase ${phase}, ${close}`);
      assert.equal(host.useTools, 1);
    }
  }
  console.log("Escape/action close, duplicate close, and queued callback races pass at six animation phases.");
  const timeout = new Host();
  const pending = timeout.popup();
  pending.unlock();
  timeout.advance(6); // no authority result; the async timeout closes the popup
  assert.equal(timeout.timers.size, 0);
  assert.equal(timeout.events.size, 0);
  pending.result("987654321");
  timeout.advance(20);
  assert.equal(timeout.previews.length, 0);
  assert.equal(timeout.lateUiWork, 0);
  console.log("Timeout followed by a late authoritative result does not revive the popup.");
}
