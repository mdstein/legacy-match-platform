#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this configuration helper as root." >&2
  exit 1
fi
if [[ $# -ne 0 ]]; then
  echo "Pipe the R2 access key and secret key on separate lines; do not pass credentials as arguments." >&2
  exit 2
fi

config_root="${AFTERTICK_CONFIG_ROOT:-/etc/aftertick}"
deploy_user="${AFTERTICK_DEPLOY_USER:-aftertick-deploy}"
api_image="${AFTERTICK_API_IMAGE:-aftertick-api:back2go-b3e6c373-20260830}"
web_image="${AFTERTICK_WEB_IMAGE:-aftertick-web:back2go-b3e6c373-20260830}"

IFS= read -r s3_access_key
IFS= read -r s3_secret_key
s3_access_key="${s3_access_key%$'\r'}"
s3_secret_key="${s3_secret_key%$'\r'}"
if IFS= read -r unexpected; then
  echo "Expected exactly two credential lines." >&2
  exit 1
fi
if [[ ! ${s3_access_key} =~ ^[A-Za-z0-9+/=_-]{20,128}$ || ! ${s3_secret_key} =~ ^[A-Za-z0-9+/=_-]{40,256}$ ]]; then
  echo "R2 credentials did not match the expected format." >&2
  exit 1
fi
if [[ -e ${config_root}/runtime.env || -e ${config_root}/migration.env || -e ${config_root}/release.env ]]; then
  echo "Production configuration already exists; refusing to rotate secrets implicitly." >&2
  exit 1
fi

postgres_password="$(openssl rand -hex 32)"
redis_password="$(openssl rand -hex 32)"
session_secret="$(openssl rand -hex 32)"
manifest_secret="$(openssl rand -hex 32)"
metrics_token="$(openssl rand -hex 32)"

install -d -m 0750 -o root -g "${deploy_user}" "${config_root}"
umask 027

cat > "${config_root}/runtime.env" <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=8787
AFTERTICK_PUBLIC_URL=https://play.back2go.net
CORS_ORIGINS=https://play.back2go.net
AFTERTICK_LATENCY_PROBE_ENDPOINTS=NA Central=game-na-central.back2go.net:27125
AFTERTICK_LATENCY_PROBE_CHALLENGE_SECONDS=120
AFTERTICK_LATENCY_MEASUREMENT_SECONDS=900
DATABASE_URL=postgres://aftertick:${postgres_password}@postgres:5432/aftertick
REDIS_URL=redis://:${redis_password}@redis:6379/0
SESSION_SECRET=${session_secret}
MANIFEST_SIGNING_SECRET=${manifest_secret}
API_RATE_LIMIT=240
AUTH_RATE_LIMIT=30
RATE_LIMIT_WINDOW_MS=60000
S3_ENDPOINT=https://0c6b32196bcfe41a7fd223c2b23d88bf.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=back2go-private-alpha-demos
S3_ACCESS_KEY=${s3_access_key}
S3_SECRET_KEY=${s3_secret_key}
AFTERTICK_DEMO_RETENTION_DAYS=90
AFTERTICK_RETENTION_BATCH_SIZE=100
AFTERTICK_BACKUP_RETENTION_DAYS=30
AFTERTICK_BACKUP_KEEP_MINIMUM=3
METRICS_BEARER_TOKEN=${metrics_token}
OTEL_SERVICE_NAME=aftertick-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_TRACES_EXPORTER=none
EOF

cat > "${config_root}/migration.env" <<EOF
DATABASE_URL=postgres://aftertick:${postgres_password}@postgres:5432/aftertick
EOF

cat > "${config_root}/release.env" <<EOF
AFTERTICK_API_IMAGE=${api_image}
AFTERTICK_WEB_IMAGE=${web_image}
AFTERTICK_CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:0aa26e284f05e6c77ae375b8c9c11d9eb6a448fb7bcd8d40f31cb6176189eb38
AFTERTICK_DEPLOY_ENV_FILE=${config_root}/runtime.env
AFTERTICK_MIGRATION_ENV_FILE=${config_root}/migration.env
AFTERTICK_TUNNEL_TOKEN_FILE=${config_root}/cloudflared.token
AFTERTICK_CLOUDFLARED_METRICS_PORT=20241
AFTERTICK_BIND_ADDRESS=127.0.0.1
AFTERTICK_HTTP_PORT=8080
POSTGRES_DB=aftertick
POSTGRES_USER=aftertick
POSTGRES_PASSWORD=${postgres_password}
REDIS_PASSWORD=${redis_password}
EOF

chown root:"${deploy_user}" \
  "${config_root}/runtime.env" \
  "${config_root}/migration.env" \
  "${config_root}/release.env"
chmod 0640 \
  "${config_root}/runtime.env" \
  "${config_root}/migration.env" \
  "${config_root}/release.env"

echo "Installed protected production runtime, migration, and release configuration."
