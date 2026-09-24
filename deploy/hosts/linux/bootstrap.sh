#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this bootstrap as root." >&2
  exit 1
fi

deploy_user="${AFTERTICK_DEPLOY_USER:-aftertick-deploy}"
install_root="${AFTERTICK_INSTALL_ROOT:-/opt/aftertick}"
config_root="${AFTERTICK_CONFIG_ROOT:-/etc/aftertick}"
state_root="${AFTERTICK_STATE_ROOT:-/var/lib/aftertick}"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! ${deploy_user} =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  echo "AFTERTICK_DEPLOY_USER is not a safe Linux account name." >&2
  exit 1
fi
for root in "${install_root}" "${config_root}" "${state_root}"; do
  if [[ ${root} != /* || ${root} == / ]]; then
    echo "Aftertick roots must be absolute, non-root paths: ${root}" >&2
    exit 1
  fi
done

if [[ ! -r /etc/os-release ]]; then
  echo "This bootstrap requires a Debian or Ubuntu host with systemd." >&2
  exit 1
fi
. /etc/os-release
case "${ID}" in
  debian|ubuntu) ;;
  *)
    echo "Unsupported distribution ${ID}; use Debian 12+ or Ubuntu 24.04+." >&2
    exit 1
    ;;
esac
command -v systemctl >/dev/null

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg jq openssl sudo unzip

if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location \
    "https://download.docker.com/linux/${ID}/gpg" \
    --output /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  architecture="$(dpkg --print-architecture)"
  codename="${VERSION_CODENAME:?VERSION_CODENAME is unavailable}"
  printf '%s\n' \
    "deb [arch=${architecture} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker.service
docker compose version >/dev/null

if ! id "${deploy_user}" >/dev/null 2>&1; then
  useradd \
    --system \
    --create-home \
    --home-dir "${state_root}/home" \
    --shell /bin/bash \
    "${deploy_user}"
fi
usermod --append --groups docker "${deploy_user}"

install -d -m 0750 -o "${deploy_user}" -g "${deploy_user}" \
  "${install_root}" "${install_root}/releases" "${state_root}"
install -d -m 0750 -o root -g "${deploy_user}" "${config_root}"
if [[ ! -f ${script_root}/deploy-release.sh || ! -f ${script_root}/install-tunnel-token.sh ]]; then
  echo "bootstrap.sh, deploy-release.sh, and install-tunnel-token.sh must be transferred together." >&2
  exit 1
fi
install -m 0755 -o root -g root \
  "${script_root}/deploy-release.sh" \
  /usr/local/bin/aftertick-deploy-release
install -m 0755 -o root -g root \
  "${script_root}/install-tunnel-token.sh" \
  /usr/local/bin/aftertick-install-tunnel-token

systemctl_path="$(command -v systemctl)"
sudoers_file="/etc/sudoers.d/aftertick-deploy"
printf '%s\n' \
  "${deploy_user} ALL=(root) NOPASSWD: ${systemctl_path} start aftertick-app.service" \
  "${deploy_user} ALL=(root) NOPASSWD: ${systemctl_path} stop aftertick-app.service" \
  "${deploy_user} ALL=(root) NOPASSWD: ${systemctl_path} restart aftertick-app.service" \
  "${deploy_user} ALL=(root) NOPASSWD: ${systemctl_path} status aftertick-app.service" \
  "${deploy_user} ALL=(root) NOPASSWD: ${systemctl_path} enable aftertick-app.service" \
  "${deploy_user} ALL=(root) NOPASSWD: /usr/local/bin/aftertick-install-tunnel-token" \
  "${deploy_user} ALL=(root) NOPASSWD: ${systemctl_path} start aftertick-retention.service" \
  "${deploy_user} ALL=(root) NOPASSWD: ${systemctl_path} enable --now aftertick-retention.timer" \
  > "${sudoers_file}"
chmod 0440 "${sudoers_file}"
visudo -cf "${sudoers_file}" >/dev/null

cat > /etc/systemd/system/aftertick-app.service <<EOF
[Unit]
Description=Aftertick API and web deployment
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
ConditionPathExists=${install_root}/current/compose.hosted.yml
ConditionPathExists=${config_root}/release.env
ConditionPathExists=${config_root}/runtime.env
ConditionPathExists=${config_root}/migration.env
ConditionPathExists=${config_root}/cloudflared.token

[Service]
Type=oneshot
RemainAfterExit=yes
User=${deploy_user}
Group=${deploy_user}
WorkingDirectory=${install_root}/current
EnvironmentFile=${config_root}/release.env
ExecStart=/usr/bin/docker compose --env-file ${config_root}/release.env -f compose.hosted.yml up -d --wait postgres redis api web cloudflared
ExecStop=/usr/bin/docker compose --env-file ${config_root}/release.env -f compose.hosted.yml stop cloudflared web api redis postgres
TimeoutStartSec=300
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/aftertick-retention.service <<EOF
[Unit]
Description=Apply Aftertick data-retention policy
Requires=docker.service
After=docker.service network-online.target aftertick-app.service
ConditionPathExists=${install_root}/current/compose.hosted.yml
ConditionPathExists=${config_root}/release.env

[Service]
Type=oneshot
User=${deploy_user}
Group=${deploy_user}
WorkingDirectory=${install_root}/current
EnvironmentFile=${config_root}/release.env
ExecStart=/usr/bin/docker compose --env-file ${config_root}/release.env -f compose.hosted.yml --profile ops run --rm retention node apps/api/dist/retention.js --apply
TimeoutStartSec=900
EOF

cat > /etc/systemd/system/aftertick-retention.timer <<'EOF'
[Unit]
Description=Run Aftertick data retention daily

[Timer]
OnCalendar=*-*-* 04:15:00
RandomizedDelaySec=1800
Persistent=true
Unit=aftertick-retention.service

[Install]
WantedBy=timers.target
EOF

chmod 0644 \
  /etc/systemd/system/aftertick-app.service \
  /etc/systemd/system/aftertick-retention.service \
  /etc/systemd/system/aftertick-retention.timer
systemctl daemon-reload

echo "Aftertick Linux host bootstrap complete."
echo "Create ${config_root}/runtime.env, migration.env, and release.env with mode 0640."
echo "Pipe the tunnel token to sudo /usr/local/bin/aftertick-install-tunnel-token."
echo "Then deploy a release as ${deploy_user}; no Aftertick service or timer was enabled automatically."
