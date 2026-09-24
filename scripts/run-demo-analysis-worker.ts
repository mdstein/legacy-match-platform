import { resolve } from "node:path";
import { createConnection } from "@aftertick/db";
import { analyzeDemoArtifact } from "./demo-analysis-worker.js";

async function main(): Promise<void> {
  const matchId = process.env["AFTERTICK_ANALYZE_MATCH_ID"];
  if (!matchId || !/^[a-f0-9-]{36}$/i.test(matchId)) {
    throw new Error("AFTERTICK_ANALYZE_MATCH_ID must be a match UUID.");
  }
  const sql = createConnection(
    process.env["DATABASE_URL"]
    ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick"
  );
  try {
    const result = await analyzeDemoArtifact(sql, {
      endpoint: process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000",
      region: process.env["S3_REGION"] ?? "us-east-1",
      bucket: process.env["S3_BUCKET"] ?? "aftertick-demos",
      accessKey: process.env["S3_ACCESS_KEY"] ?? "aftertick-local",
      secretKey: process.env["S3_SECRET_KEY"] ?? "aftertick-local-minio-secret",
      analyzerPath: resolve(
        import.meta.dirname,
        "..",
        ".artifacts",
        "bin",
        process.platform === "win32" ? "aftertick-demo-analyzer.exe" : "aftertick-demo-analyzer"
      )
    }, matchId);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
