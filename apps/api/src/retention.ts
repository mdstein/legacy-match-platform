import { createConnection } from "@aftertick/db";
import { z } from "zod";
import { S3DemoObjectStore } from "./demo-ingestion-service.js";
import { DemoRetentionService } from "./retention-service.js";

const environment = z.object({
  DATABASE_URL: z.string().url(),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: z.string().min(8),
  AFTERTICK_DEMO_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(90),
  AFTERTICK_RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100)
}).parse(process.env);

const apply = process.argv.includes("--apply");
const sql = createConnection(environment.DATABASE_URL);
const objects = new S3DemoObjectStore({
  endpoint: environment.S3_ENDPOINT,
  region: environment.S3_REGION,
  bucket: environment.S3_BUCKET,
  accessKey: environment.S3_ACCESS_KEY,
  secretKey: environment.S3_SECRET_KEY
});

try {
  await objects.ready();
  const result = await new DemoRetentionService(sql, objects).run({
    apply,
    retentionDays: environment.AFTERTICK_DEMO_RETENTION_DAYS,
    limit: environment.AFTERTICK_RETENTION_BATCH_SIZE
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.failed > 0) process.exitCode = 1;
} finally {
  objects.close();
  await sql.end();
}
