import http from "k6/http";
import { check } from "k6";

const baseUrl = __ENV.AFTERTICK_BASE_URL || "http://127.0.0.1:8792";

export const options = {
  vus: 10,
  duration: "10s",
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"]
  }
};

export default function () {
  const ready = http.get(`${baseUrl}/ready`, { tags: { operation: "readiness" } });
  check(ready, {
    "API is ready": (response) => response.status === 200,
    "PostgreSQL is ready": (response) => response.json("checks.postgres.status") === "ok",
    "Redis is ready": (response) => response.json("checks.redis.status") === "ok"
  });

  const csrf = http.get(`${baseUrl}/api/auth/csrf`, { tags: { operation: "csrf" } });
  const token = csrf.json("token");
  check(csrf, {
    "CSRF token issued": (response) => response.status === 200 && typeof token === "string"
  });

  const mutation = http.post(`${baseUrl}/api/queue/leave`, null, {
    headers: { "X-CSRF-Token": token },
    tags: { operation: "queue-leave" }
  });
  check(mutation, {
    "authenticated mutation accepted": (response) => response.status === 200
  });
}
