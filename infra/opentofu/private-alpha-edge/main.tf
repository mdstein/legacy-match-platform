locals {
  zone_name     = lower(trimspace(var.domain))
  app_hostname  = "${var.app_subdomain}.${local.zone_name}"
  game_hostname = "${var.game_subdomain}.${local.zone_name}"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "app" {
  account_id = var.cloudflare_account_id
  name       = var.tunnel_name
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "app" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.app.id
  source     = "cloudflare"
  config = {
    ingress = [
      {
        hostname = local.app_hostname
        service  = "http://web:8080"
        origin_request = {
          connect_timeout        = 10
          keep_alive_connections = 100
          keep_alive_timeout     = 90
          tcp_keep_alive         = 30
        }
      },
      {
        service = "http_status:404"
      }
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "app" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.app.id
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = local.app_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.app.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "Legacy Match outbound-only private-alpha tunnel; managed by OpenTofu"
}

resource "cloudflare_dns_record" "game" {
  zone_id = var.cloudflare_zone_id
  name    = local.game_hostname
  type    = "A"
  content = var.game_origin_ipv4
  proxied = false
  ttl     = 300
  comment = "Legacy Match ${var.route_label} direct UDP game/GOTV endpoint; managed by OpenTofu"
}

resource "cloudflare_r2_bucket" "demos" {
  account_id    = var.cloudflare_account_id
  name          = var.demo_bucket_name
  location      = "enam"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_managed_domain" "demos" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.demos.name
  enabled     = false
}
