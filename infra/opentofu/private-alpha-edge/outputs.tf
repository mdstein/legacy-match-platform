output "public_url" {
  description = "HTTPS browser origin configured as AFTERTICK_PUBLIC_URL and CORS_ORIGINS."
  value       = "https://${local.app_hostname}"
}

output "cloudflared_tunnel_id" {
  description = "Remotely managed application tunnel UUID."
  value       = cloudflare_zero_trust_tunnel_cloudflared.app.id
}

output "cloudflared_tunnel_token" {
  description = "Single-purpose connector token. Pipe directly to the protected host installer; never log or commit it."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.app.token
  sensitive   = true
}

output "game_endpoint" {
  description = "Direct UDP endpoint advertised by the node agent and match manifests."
  value       = "${local.game_hostname}:${var.game_port}"
}

output "gotv_endpoint" {
  description = "Direct UDP GOTV endpoint checked by hosted acceptance."
  value       = "${local.game_hostname}:${var.gotv_port}"
}

output "latency_probe_endpoints" {
  description = "Exact AFTERTICK_LATENCY_PROBE_ENDPOINTS value for this first region."
  value       = "${var.route_label}=${local.game_hostname}:${var.latency_probe_port}"
}

output "application_environment" {
  description = "Non-secret production environment values. Inject R2 access keys separately."
  value = {
    AFTERTICK_PUBLIC_URL              = "https://${local.app_hostname}"
    CORS_ORIGINS                      = "https://${local.app_hostname}"
    AFTERTICK_LATENCY_PROBE_ENDPOINTS = "${var.route_label}=${local.game_hostname}:${var.latency_probe_port}"
    S3_ENDPOINT                       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
    S3_REGION                         = "auto"
    S3_BUCKET                         = cloudflare_r2_bucket.demos.name
  }
}
