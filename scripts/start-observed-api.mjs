if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  process.env.OTEL_SERVICE_NAME ??= "aftertick-api";
  process.env.OTEL_TRACES_EXPORTER ??= "otlp";
  process.env.OTEL_NODE_RESOURCE_DETECTORS ??= "env,host,os";
  await import("@opentelemetry/auto-instrumentations-node/register");
}

await import("../apps/api/dist/server.js");
