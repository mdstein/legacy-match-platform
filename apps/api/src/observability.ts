import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

interface TraceContext {
  requestId: string;
  traceId: string;
  spanId: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

function safeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function routeLabel(req: Request): string {
  return req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : "unmatched";
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, number[]>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, labels: Record<string, string>, seconds: number): void {
    const key = this.key(name, labels);
    const values = this.durations.get(key) ?? [];
    values.push(seconds);
    if (values.length > 10_000) values.splice(0, values.length - 10_000);
    this.durations.set(key, values);
  }

  setGauge(name: string, labels: Record<string, string>, value: number): void {
    this.gauges.set(this.key(name, labels), value);
  }

  render(): string {
    const lines = [
      "# HELP aftertick_http_requests_total Completed HTTP requests.",
      "# TYPE aftertick_http_requests_total counter"
    ];
    for (const [key, value] of [...this.counters].sort()) lines.push(`${key} ${value}`);

    lines.push(
      "# HELP aftertick_http_request_duration_seconds HTTP request latency.",
      "# TYPE aftertick_http_request_duration_seconds histogram"
    );
    const buckets = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
    for (const [key, values] of [...this.durations].sort()) {
      const brace = key.indexOf("{");
      const name = brace === -1 ? key : key.slice(0, brace);
      const labels = brace === -1 ? "" : key.slice(brace + 1, -1);
      const prefix = labels ? `${labels},` : "";
      for (const bucket of buckets) {
        lines.push(`${name}_bucket{${prefix}le="${bucket}"} ${values.filter((value) => value <= bucket).length}`);
      }
      lines.push(`${name}_bucket{${prefix}le="+Inf"} ${values.length}`);
      lines.push(`${name}_sum${labels ? `{${labels}}` : ""} ${values.reduce((sum, value) => sum + value, 0)}`);
      lines.push(`${name}_count${labels ? `{${labels}}` : ""} ${values.length}`);
    }

    let priorGaugeName: string | null = null;
    for (const [key, value] of [...this.gauges].sort()) {
      const brace = key.indexOf("{");
      const name = brace === -1 ? key : key.slice(0, brace);
      if (name !== priorGaugeName) {
        lines.push(`# TYPE ${name} gauge`);
        priorGaugeName = name;
      }
      lines.push(`${key} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return name;
    return `${name}{${entries.map(([key, value]) => `${key}="${safeLabel(value)}"`).join(",")}}`;
  }
}

export interface Observability {
  metrics: MetricsRegistry;
  middleware(req: Request, res: Response, next: NextFunction): void;
  log(level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void;
}

function incomingTraceId(value: string | undefined): string | null {
  const match = value?.match(/^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function createObservability(write: (line: string) => void = console.log): Observability {
  const metrics = new MetricsRegistry();
  const log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) => {
    const context = traceStorage.getStore();
    write(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(context ?? {}),
      ...fields
    }));
  };

  return {
    metrics,
    log,
    middleware(req, res, next) {
      const context: TraceContext = {
        requestId: req.get("X-Request-Id")?.slice(0, 128) || randomUUID(),
        traceId: incomingTraceId(req.get("traceparent")) ?? randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex")
      };
      const startedAt = performance.now();
      res.setHeader("X-Request-Id", context.requestId);
      res.setHeader("traceparent", `00-${context.traceId}-${context.spanId}-01`);
      traceStorage.run(context, () => {
        res.once("finish", () => {
          const route = routeLabel(req);
          const seconds = (performance.now() - startedAt) / 1_000;
          metrics.increment("aftertick_http_requests_total", {
            method: req.method,
            route,
            status: String(res.statusCode)
          });
          metrics.observe("aftertick_http_request_duration_seconds", { method: req.method, route }, seconds);
          log(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http.request.completed", {
            method: req.method,
            route,
            status: res.statusCode,
            durationMs: Math.round(seconds * 1_000)
          });
        });
        next();
      });
    }
  };
}
