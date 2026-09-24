#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer through the bootstrap-authorized sudo command." >&2
  exit 1
fi
if [[ $# -ne 0 ]]; then
  echo "The tunnel token must arrive on standard input, never as a command argument." >&2
  exit 2
fi

deploy_user="${AFTERTICK_DEPLOY_USER:-aftertick-deploy}"
config_root="${AFTERTICK_CONFIG_ROOT:-/etc/aftertick}"
token_path="${config_root}/cloudflared.token"

if [[ ! ${deploy_user} =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  echo "AFTERTICK_DEPLOY_USER is not a safe Linux account name." >&2
  exit 1
fi
if [[ ${config_root} != /* || ${config_root} == / ]]; then
  echo "AFTERTICK_CONFIG_ROOT must be an absolute, non-root path." >&2
  exit 1
fi
if ! id "${deploy_user}" >/dev/null 2>&1; then
  echo "Deployment account does not exist: ${deploy_user}" >&2
  exit 1
fi

IFS= read -r token || true
token="${token%$'\r'}"
if [[ ${#token} -lt 80 || ${#token} -gt 4096 || ! ${token} =~ ^[A-Za-z0-9._=+/-]+$ ]]; then
  echo "Standard input was not a plausible Cloudflare tunnel token." >&2
  exit 1
fi
if IFS= read -r _; then
  echo "Tunnel token input must contain exactly one non-empty line." >&2
  exit 1
fi

install -d -m 0750 -o root -g "${deploy_user}" "${config_root}"
temporary="$(mktemp "${config_root}/.cloudflared.token.XXXXXX")"
cleanup() {
  rm -f -- "${temporary}"
}
trap cleanup EXIT
printf '%s\n' "${token}" > "${temporary}"
chown root:"${deploy_user}" "${temporary}"
chmod 0640 "${temporary}"
mv -f -- "${temporary}" "${token_path}"
trap - EXIT

echo "Installed protected tunnel connector token at ${token_path}."
