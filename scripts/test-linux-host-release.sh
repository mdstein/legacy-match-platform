#!/usr/bin/env bash
set -Eeuo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash -n \
  "${workspace}/deploy/hosts/linux/bootstrap.sh" \
  "${workspace}/deploy/hosts/linux/deploy-release.sh" \
  "${workspace}/deploy/hosts/linux/install-tunnel-token.sh"
test_root="$(mktemp -d)"
real_sudo="$(command -v sudo || true)"
privileged_cleanup=""
cleanup() {
  if [[ -n ${privileged_cleanup} && -e ${privileged_cleanup} && ${EUID} -ne 0 ]]; then
    "${real_sudo}" rm -rf -- "${privileged_cleanup}"
  fi
  rm -rf -- "${test_root}"
}
trap cleanup EXIT

bin_root="${test_root}/bin"
config_root="${test_root}/config"
install_root="${test_root}/install"
source_one="${test_root}/source-one"
source_two="${test_root}/source-two"
mkdir -p "${bin_root}" "${config_root}" "${install_root}/releases" "${source_one}" "${source_two}"

cat > "${bin_root}/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'docker %s\n' "$*" >> "${AFTERTICK_TEST_COMMAND_LOG}"
exit 0
EOF
cat > "${bin_root}/sudo" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'sudo %s\n' "$*" >> "${AFTERTICK_TEST_COMMAND_LOG}"
if [[ -n ${AFTERTICK_TEST_FAIL_ONCE_FILE:-} && ! -e ${AFTERTICK_TEST_FAIL_ONCE_FILE} ]]; then
  touch "${AFTERTICK_TEST_FAIL_ONCE_FILE}"
  exit 1
fi
exit 0
EOF
chmod 0755 "${bin_root}/docker" "${bin_root}/sudo"

for release_source in "${source_one}" "${source_two}"; do
  printf 'services: {}\n' > "${release_source}/compose.hosted.yml"
  printf '{"version":"fixture"}\n' > "${release_source}/release-manifest.json"
  (
    cd "${release_source}"
    sha256sum compose.hosted.yml release-manifest.json > SHA256SUMS
  )
done
cat > "${config_root}/release.env" <<EOF
AFTERTICK_API_IMAGE=ghcr.io/aftertick/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
AFTERTICK_WEB_IMAGE=ghcr.io/aftertick/web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
AFTERTICK_CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
AFTERTICK_DEPLOY_ENV_FILE=${config_root}/runtime.env
AFTERTICK_MIGRATION_ENV_FILE=${config_root}/migration.env
AFTERTICK_TUNNEL_TOKEN_FILE=${config_root}/cloudflared.token
AFTERTICK_BIND_ADDRESS=127.0.0.1
AFTERTICK_HTTP_PORT=8080
AFTERTICK_CLOUDFLARED_METRICS_PORT=20241
EOF
printf 'RUNTIME=fixture\n' > "${config_root}/runtime.env"
printf 'MIGRATION=fixture\n' > "${config_root}/migration.env"
printf 'eyJfixture0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-.eyJfixture0123456789abcdefghijklmnopqrstuvwxyz\n' > "${config_root}/cloudflared.token"
chmod 0640 "${config_root}/release.env" "${config_root}/runtime.env" "${config_root}/migration.env" "${config_root}/cloudflared.token"

export PATH="${bin_root}:${PATH}"
export AFTERTICK_INSTALL_ROOT="${install_root}"
export AFTERTICK_CONFIG_ROOT="${config_root}"
export AFTERTICK_TEST_COMMAND_LOG="${test_root}/commands.log"

tunnel_config_root="${test_root}/tunnel-config"
tunnel_token='eyJfixture0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-.eyJfixture0123456789abcdefghijklmnopqrstuvwxyz'
test_deploy_user="$(id -un)"
privileged_cleanup="${tunnel_config_root}"
run_tunnel_installer() {
  if [[ ${EUID} -eq 0 ]]; then
    env \
      AFTERTICK_DEPLOY_USER="${test_deploy_user}" \
      AFTERTICK_CONFIG_ROOT="${tunnel_config_root}" \
      "${workspace}/deploy/hosts/linux/install-tunnel-token.sh" "$@"
    return
  fi
  if [[ -z ${real_sudo} ]]; then
    echo "The non-root tunnel installer fixture requires sudo." >&2
    return 1
  fi
  "${real_sudo}" env \
    AFTERTICK_DEPLOY_USER="${test_deploy_user}" \
    AFTERTICK_CONFIG_ROOT="${tunnel_config_root}" \
    "${workspace}/deploy/hosts/linux/install-tunnel-token.sh" "$@"
}
printf '%s\n' "${tunnel_token}" | \
  run_tunnel_installer
if [[ $(stat -c '%a' "${tunnel_config_root}/cloudflared.token") != 640 ]]; then
  echo "Tunnel token installer did not enforce mode 0640." >&2
  exit 1
fi
if [[ $(<"${tunnel_config_root}/cloudflared.token") != "${tunnel_token}" ]]; then
  echo "Tunnel token installer changed the supplied credential." >&2
  exit 1
fi
if printf 'too-short\n' | \
  run_tunnel_installer >/dev/null 2>&1; then
  echo "Tunnel token installer accepted an invalid credential." >&2
  exit 1
fi
if printf '%s\nsecond-line\n' "${tunnel_token}" | \
  run_tunnel_installer >/dev/null 2>&1; then
  echo "Tunnel token installer accepted multiple input lines." >&2
  exit 1
fi
if run_tunnel_installer "${tunnel_token}" >/dev/null 2>&1; then
  echo "Tunnel token installer accepted a credential as a process argument." >&2
  exit 1
fi
if [[ $(<"${tunnel_config_root}/cloudflared.token") != "${tunnel_token}" ]]; then
  echo "A rejected token attempt changed the previously installed credential." >&2
  exit 1
fi

"${workspace}/deploy/hosts/linux/deploy-release.sh" "${source_one}" "release-one"
first="$(readlink "${install_root}/current")"
if [[ $(basename "${first}") != "release-one" ]]; then
  echo "First release pointer was not activated." >&2
  exit 1
fi
if ! grep -q -- '--profile ops run --rm migrate' "${AFTERTICK_TEST_COMMAND_LOG}"; then
  echo "Migration was not run before activation." >&2
  exit 1
fi
if ! grep -q -- 'image inspect cloudflare/cloudflared@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' "${AFTERTICK_TEST_COMMAND_LOG}"; then
  echo "The immutable cloudflared image was not verified before release activation." >&2
  exit 1
fi
if ! grep -q -- 'up -d --wait postgres redis' "${AFTERTICK_TEST_COMMAND_LOG}"; then
  echo "Durable services were not made ready before migrations." >&2
  exit 1
fi

sed -i 's/^AFTERTICK_BIND_ADDRESS=.*/AFTERTICK_BIND_ADDRESS=0.0.0.0/' "${config_root}/release.env"
if "${workspace}/deploy/hosts/linux/deploy-release.sh" "${source_two}" "unsafe-bind" >/dev/null 2>&1; then
  echo "Hosted release accepted a public application bind address." >&2
  exit 1
fi
sed -i 's/^AFTERTICK_BIND_ADDRESS=.*/AFTERTICK_BIND_ADDRESS=127.0.0.1/' "${config_root}/release.env"

export AFTERTICK_TEST_FAIL_ONCE_FILE="${test_root}/fail-once"
if "${workspace}/deploy/hosts/linux/deploy-release.sh" "${source_two}" "release-two"; then
  echo "Readiness failure unexpectedly succeeded." >&2
  exit 1
fi
restored="$(readlink "${install_root}/current")"
if [[ $(basename "${restored}") != "release-one" ]]; then
  echo "Failed release did not restore the prior release pointer." >&2
  exit 1
fi

echo "Linux immutable release activation and rollback fixture passed."
