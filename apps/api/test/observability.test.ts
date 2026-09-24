import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createObservability } from "../src/observability.js";

describe("observability", () => {
  it("emits correlated structured request logs and Prometheus metrics", async () => {
    const lines: string[] = [];
    const observability = createObservability((line) => lines.push(line));
    const token = "aftertick-test-metrics-token-with-32-characters";
    const app = createApp({ observability, metricsToken: token });
    const traceId = "1234567890abcdef1234567890abcdef";

    const health = await request(app)
      .get("/health")
      .set("traceparent", `00-${traceId}-1234567890abcdef-01`)
      .expect(200);
    expect(health.headers.traceparent).toMatch(new RegExp(`^00-${traceId}-[a-f0-9]{16}-01$`));
    expect(health.headers["x-request-id"]).toBeTruthy();

    await request(app).get("/metrics").expect(401);
    const metrics = await request(app)
      .get("/metrics")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(metrics.text).toContain("aftertick_http_requests_total");
    expect(metrics.text).toContain('route="/health"');
    expect(metrics.text).toContain("aftertick_http_request_duration_seconds_bucket");

    const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === "http.request.completed" && line.route === "/health");
    expect(event).toMatchObject({ traceId, method: "GET", status: 200 });
  });

  it("escapes metric labels and records gauges", () => {
    const observability = createObservability(() => undefined);
    observability.metrics.increment("aftertick_test_total", { value: 'a"b' });
    observability.metrics.setGauge("aftertick_runtime_gauge", { kind: "queue" }, 7);
    const output = observability.metrics.render();
    expect(output).toContain('aftertick_test_total{value="a\\"b"} 1');
    expect(output).toContain('aftertick_runtime_gauge{kind="queue"} 7');
  });
});
