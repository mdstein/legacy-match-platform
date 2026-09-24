#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 RELEASE_SOURCE RELEASE_ID" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
source_root="$(realpath "$1")"
release_id="$2"
install_root="${AFTERTICK_INSTALL_ROOT:-/opt/aftertick}"
config_root="${AFTERTICK_CONFIG_ROOT:-/etc/aftertick}"
release_root="${install_root}/releases"
target="${release_root}/${release_id}"
current="${install_root}/current"
release_env="${config_root}/release.env"

for root in "${install_root}" "${config_root}"; do
  if [[ ${root} != /* || ${root} == / ]]; then
    echo "Aftertick roots must be absolute, non-root paths: ${root}" >&2
    exit 1
  fi
done
if [[ ! ${release_id} =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]]; then
  echo "RELEASE_ID must be a safe immutable identifier." >&2
  exit 1
fi
if [[ ! -f ${source_root}/compose.hosted.yml ]]; then
  echo "Release source has no compose.hosted.yml: ${source_root}" >&2
  exit 1
fi
if [[ ! -f ${source_root}/release-manifest.json || ! -f ${source_root}/SHA256SUMS ]]; then
  echo "Release source has no manifest/checksum set: ${source_root}" >&2
  exit 1
fi
if grep -Evq '^[a-f0-9]{64}  [a-zA-Z0-9._/-]+$' "${source_root}/SHA256SUMS"; then
  echo "Release SHA256SUMS contains an unsafe entry." >&2
  exit 1
fi
(cd "${source_root}" && sha256sum --check --strict SHA256SUMS)
file_count="$(find "${source_root}" -type f | wc -l | tr -d ' ')"
if [[ ${file_count} -ne 3 ]]; then
  echo "Release source must contain only compose.hosted.yml, release-manifest.json, and SHA256SUMS." >&2
  exit 1
fi
for file in "${release_env}" "${config_root}/runtime.env" "${config_root}/migration.env" "${config_root}/cloudflared.token"; do
  if [[ ! -f ${file} ]]; then
    echo "Required deployment file is missing: ${file}" >&2
    exit 1
  fi
  mode="$(stat -c '%a' "${file}")"
  if (( (8#${mode} & 8#007) != 0 )); then
    echo "Deployment file must not be accessible to other users: ${file} (${mode})" >&2
    exit 1
  fi
done

release_value() {
  local key="$1"
  local count
  count="$(grep -Ec "^${key}=" "${release_env}")"
  if [[ ${count} -ne 1 ]]; then
    echo "release.env must contain exactly one ${key} entry." >&2
    exit 1
  fi
  awk -F= -v expected="${key}" '$1 == expected { sub(/^[^=]*=/, ""); print; exit }' "${release_env}"
}

runtime_env="$(release_value AFTERTICK_DEPLOY_ENV_FILE)"
migration_env="$(release_value AFTERTICK_MIGRATION_ENV_FILE)"
tunnel_token_file="$(release_value AFTERTICK_TUNNEL_TOKEN_FILE)"
bind_address="$(release_value AFTERTICK_BIND_ADDRESS)"
http_port="$(release_value AFTERTICK_HTTP_PORT)"
tunnel_metrics_port="$(release_value AFTERTICK_CLOUDFLARED_METRICS_PORT)"

for mapping in \
  "${runtime_env}|${config_root}/runtime.env|runtime environment" \
  "${migration_env}|${config_root}/migration.env|migration environment" \
  "${tunnel_token_file}|${config_root}/cloudflared.token|tunnel token"; do
  IFS='|' read -r configured expected label <<< "${mapping}"
  if [[ ! -f ${configured} || $(realpath "${configured}") != $(realpath "${expected}") ]]; then
    echo "The ${label} path must resolve to ${expected}." >&2
    exit 1
  fi
done
if [[ ${bind_address} != 127.0.0.1 ]]; then
  echo "Hosted web ingress must remain bound to 127.0.0.1 behind the tunnel." >&2
  exit 1
fi
for port in "${http_port}" "${tunnel_metrics_port}"; do
  if [[ ! ${port} =~ ^[0-9]+$ ]]; then
    echo "Hosted loopback ports must be numeric values between 1024 and 65535." >&2
    exit 1
  fi
  if (( port < 1024 || port > 65535 )); then
    echo "Hosted loopback ports must be numeric values between 1024 and 65535." >&2
    exit 1
  fi
done
if [[ ${http_port} == "${tunnel_metrics_port}" ]]; then
  echo "Hosted web and tunnel metrics ports must differ." >&2
  exit 1
fi

if [[ -e ${target} ]]; then
  echo "Release already exists and will not be overwritten: ${target}" >&2
  exit 1
fi
install -d -m 0750 "${release_root}"
install -d -m 0750 "${target}"
cp -a "${source_root}/." "${target}/"
release_owner="$(stat -c '%u' "${release_root}")"
release_group="$(stat -c '%g' "${release_root}")"
chown -R -- "${release_owner}:${release_group}" "${target}"

compose=(docker compose --env-file "${release_env}" -f "${target}/compose.hosted.yml")
"${compose[@]}" config --quiet

api_image="$(release_value AFTERTICK_API_IMAGE)"
web_image="$(release_value AFTERTICK_WEB_IMAGE)"
cloudflared_image="$(release_value AFTERTICK_CLOUDFLARED_IMAGE)"
for image in "${api_image}" "${web_image}" "${cloudflared_image}"; do
  if [[ ! ${image} =~ @sha256:[a-f0-9]{64}$ && ! ${image} =~ :[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]]; then
    echo "Production image references must use a registry digest or an immutable release tag: ${image}" >&2
    exit 1
  fi
done

for mapping in \
  "postgres|postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73" \
  "redis|redis@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf" \
  "api|${api_image}" \
  "web|${web_image}" \
  "cloudflared|${cloudflared_image}"; do
  IFS='|' read -r service image <<< "${mapping}"
  if ! docker image inspect "${image}" >/dev/null 2>&1; then
    "${compose[@]}" pull "${service}"
  fi
done
"${compose[@]}" up -d --wait postgres redis
"${compose[@]}" --profile ops run --rm migrate

previous=""
if [[ -L ${current} ]]; then
  previous="$(readlink -f "${current}")"
fi
next_link="${install_root}/.current-${release_id}"
ln -s "${target}" "${next_link}"
mv -Tf "${next_link}" "${current}"

if ! sudo systemctl restart aftertick-app.service; then
  echo "Release failed readiness; restoring the previous release pointer." >&2
  if [[ -n ${previous} && -d ${previous} ]]; then
    rollback_link="${install_root}/.rollback-${release_id}"
    ln -s "${previous}" "${rollback_link}"
    mv -Tf "${rollback_link}" "${current}"
    sudo systemctl restart aftertick-app.service || true
  fi
  exit 1
fi

echo "Aftertick release ${release_id} is active at ${target}."
echo "Enable aftertick-app.service and aftertick-retention.timer after the first release verification."
