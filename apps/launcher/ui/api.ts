import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

// Responses are the existing launcher API's JSON records. Auth tokens never
// cross this boundary; Rust chooses the endpoint and attaches credentials.
export type Data = Record<string, any>;
export interface Status {
  version: string;
  paired: boolean;
  gameOpen: boolean;
  profileIcon: string;
  debugConsole: boolean;
  installation: {
    steamAvailable: boolean;
    ready: boolean;
    downloaded: number;
    total: number;
    detail: string;
  };
  session: {
    phase: "idle" | "starting" | "running" | "failed";
    message: string;
    pairing: boolean;
    pairCode: string | null;
    pairUrl: string | null;
    installing: boolean;
    preparing: boolean;
    installError: string | null;
    revision: number;
  };
}
export const call = <T = Data>(
  operation: string,
  args: Data = {},
): Promise<T> => invoke("launcher_call", { operation, args });
export const errorText = (error: unknown) =>
  typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "B2G could not finish this action. Please retry.";
export const invalidate = () => window.dispatchEvent(new Event("b2g-refresh"));
const cache = new Map<string, unknown>();
let generation = 0;
export const disconnectAccount = () => {
  // Keep the native installation/session snapshot while removing private
  // account data. Erasing status here turns paired=false into undefined and
  // retriggers the sign-out effect on every status response.
  const status = cache.get("status") as Status | undefined;
  generation++;
  cache.clear();
  if (status) cache.set("status", { ...status, paired: false });
  window.dispatchEvent(new Event("b2g-cache-reset"));
};

export function useRemote<T = Data>(
  key: string,
  operation: string,
  args: Data = {},
  enabled = true,
  interval = 0,
) {
  const [snapshot, setSnapshot] = useState({
    key,
    generation,
    data: cache.get(key) as T | undefined,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(enabled && !cache.has(key));
  const request = useRef(0);
  const inFlight = useRef<{
    key: string;
    generation: number;
    promise: Promise<void>;
  } | null>(null);
  const current = useRef(key);
  current.current = key;
  const argsJson = JSON.stringify(args);
  const refresh = useCallback((): Promise<void> => {
    if (!enabled) return Promise.resolve();
    // A slow connection must still settle. Starting another poll must never
    // invalidate the response that is already on its way.
    if (
      inFlight.current?.key === key &&
      inFlight.current.generation === generation
    )
      return inFlight.current.promise;
    const sequence = ++request.current;
    const epoch = generation;
    if (!cache.has(key)) setLoading(true);
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const next = await call<T>(operation, JSON.parse(argsJson));
        if (
          epoch !== generation ||
          current.current !== key ||
          sequence !== request.current
        )
          return;
        const prior = cache.get(key);
        if (JSON.stringify(prior) !== JSON.stringify(next)) {
          if (cache.size >= 128) cache.delete(cache.keys().next().value!);
          cache.set(key, next);
          setSnapshot({ key, generation: epoch, data: next });
        } else
          setSnapshot((previous) =>
            previous.key === key &&
            previous.generation === epoch &&
            previous.data === prior
              ? previous
              : { key, generation: epoch, data: prior as T },
          );
        setError("");
      } catch (e) {
        if (
          epoch === generation &&
          current.current === key &&
          sequence === request.current
        )
          setError(errorText(e));
      } finally {
        if (inFlight.current?.promise === promise) inFlight.current = null;
        if (
          epoch === generation &&
          current.current === key &&
          sequence === request.current
        )
          setLoading(false);
      }
    })();
    inFlight.current = { key, generation: epoch, promise };
    return promise;
  }, [key, operation, argsJson, enabled]);
  useEffect(() => {
    setSnapshot({ key, generation, data: cache.get(key) as T | undefined });
    setError("");
    setLoading(enabled && !cache.has(key));
    void refresh();
    const timer =
      interval && enabled
        ? window.setInterval(() => {
            if (!document.hidden) void refresh();
          }, interval)
        : undefined;
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    const reset = () => {
      request.current++;
      inFlight.current = null;
      setSnapshot({ key, generation, data: cache.get(key) as T | undefined });
      setError("");
      setLoading(enabled && !cache.has(key));
      // Components will disable their account reads on the next render.
      // Do not launch fresh authenticated requests with the old closures.
      if (operation === "status") void refresh();
    };
    window.addEventListener("b2g-refresh", refresh);
    window.addEventListener("b2g-cache-reset", reset);
    document.addEventListener("visibilitychange", visible);
    return () => {
      request.current++;
      inFlight.current = null;
      clearInterval(timer);
      window.removeEventListener("b2g-refresh", refresh);
      window.removeEventListener("b2g-cache-reset", reset);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [key, enabled, interval, refresh]);
  const matches = snapshot.key === key && snapshot.generation === generation;
  return {
    data: matches ? snapshot.data : (cache.get(key) as T | undefined),
    error: matches ? error : "",
    loading: matches ? loading : enabled && !cache.has(key),
    refresh,
  };
}

export function useAction() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const run = async <T = Data>(
    operation: string,
    args: Data = {},
    success?: string,
  ): Promise<T | undefined> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(operation);
    setError("");
    setNotice("");
    try {
      const result = await call<T>(operation, args);
      if (success) setNotice(success);
      return result;
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      lock.current = false;
      setBusy("");
    }
  };
  return { busy, error, notice, run, setError, setNotice };
}
export const display = (value: unknown, fallback: string | number = "—") =>
  String(
    value === null || value === undefined || value === "" ? fallback : value,
  );
export const date = (value: unknown) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
export const regionList = ["NA Central", "NA East", "NA West", "EU Central"];
