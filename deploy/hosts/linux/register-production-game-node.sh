#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this registration helper as root." >&2
  exit 1
fi
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 OUTPUT_ENV_FILE" >&2
  exit 2
fi
if [[ ! ${AFTERTICK_SRCDS_GSLT:-} =~ ^[a-fA-F0-9]{32}$ ]]; then
  echo "Set AFTERTICK_SRCDS_GSLT to a token created for Steam AppID 4465480." >&2
  exit 1
fi

output="$(realpath -m "$1")"
case "${output}" in
  /root/*|/var/lib/aftertick/*) ;;
  *)
    echo "The credential output must remain under /root or /var/lib/aftertick." >&2
    exit 1
    ;;
esac
if [[ -e ${output} ]]; then
  echo "Node credentials already exist; refusing to rotate them implicitly." >&2
  exit 1
fi

runtime_env="/etc/aftertick/runtime.env"
if [[ ! -r ${runtime_env} ]]; then
  echo "Production runtime configuration is missing." >&2
  exit 1
fi
manifest_secret="$(awk -F= '$1 == "MANIFEST_SIGNING_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "${runtime_env}")"
if (( ${#manifest_secret} < 32 )); then
  echo "The production manifest signing secret is invalid." >&2
  exit 1
fi

node_token="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
token_sha256="$(printf '%s' "${node_token}" | sha256sum | cut -d' ' -f1)"
rcon_password="$(openssl rand -hex 32)"
idle_password="$(openssl rand -hex 32)"

docker exec aftertick-postgres-1 psql -v ON_ERROR_STOP=1 -U aftertick -d aftertick \
  -c "insert into game_nodes (name, region, public_endpoint, token_sha256) values ('na-central-01', 'NA Central', 'game-na-central.back2go.net:27115', '${token_sha256}') on conflict (name) do update set region=excluded.region, public_endpoint=excluded.public_endpoint, token_sha256=excluded.token_sha256, status='offline', updated_at=now();" \
  >/dev/null

umask 077
cat > "${output}" <<EOF
AFTERTICK_API_URL=https://play.back2go.net
AFTERTICK_NODE_TOKEN=${node_token}
MANIFEST_SIGNING_SECRET=${manifest_secret}
AFTERTICK_SERVER_ROOT=C:\ProgramData\Aftertick\tools\csgo-server
AFTERTICK_SRCDS_LAUNCHER=C:\ProgramData\Aftertick\service\start-srcds-hidden.ps1
AFTERTICK_NODE_INSTANCE_KEY=csgo-01
AFTERTICK_SERVER_ADDRESS=game-na-central.back2go.net:27115
AFTERTICK_SRCDS_HOST=0.0.0.0
AFTERTICK_SRCDS_PORT=27115
AFTERTICK_GOTV_PORT=27120
AFTERTICK_LATENCY_PROBE_PORT=27125
AFTERTICK_SRCDS_LAN=0
AFTERTICK_SRCDS_GSLT=${AFTERTICK_SRCDS_GSLT}
AFTERTICK_SRCDS_RCON=${rcon_password}
AFTERTICK_SRCDS_IDLE_PASSWORD=${idle_password}
AFTERTICK_NODE_HEARTBEAT_MS=2000
AFTERTICK_SERVER_BUILD_ID=12426148
AFTERTICK_PLUGIN_VERSION=0.1.0
EOF
chmod 0600 "${output}"

echo "Registered na-central-01 and created its protected credential file."
