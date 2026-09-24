mock_provider "cloudflare" {}

variables {
  cloudflare_account_id = "0123456789abcdef0123456789abcdef"
  cloudflare_zone_id    = "abcdef0123456789abcdef0123456789"
  domain                = "legacy-match.example"
  game_origin_ipv4      = "198.51.100.20"
  demo_bucket_name      = "legacy-match-private-alpha-demos"
  game_subdomain        = "game-na-east"
  route_label           = "NA East"
}

run "vint_hill_defaults" {
  command = plan

  assert {
    condition     = output.public_url == "https://play.legacy-match.example"
    error_message = "The application URL must use the default play hostname."
  }

  assert {
    condition     = output.latency_probe_endpoints == "NA East=game-na-east.legacy-match.example:27125"
    error_message = "The default signed-latency route must be the Vint Hill NA East endpoint."
  }

  assert {
    condition     = cloudflare_dns_record.app.type == "CNAME" && cloudflare_dns_record.app.proxied && cloudflare_dns_record.app.ttl == 1
    error_message = "The HTTPS application record must route the remotely managed tunnel through Cloudflare."
  }

  assert {
    condition = (
      cloudflare_zero_trust_tunnel_cloudflared.app.config_src == "cloudflare"
      && cloudflare_zero_trust_tunnel_cloudflared_config.app.config.ingress[0].hostname == "play.legacy-match.example"
      && cloudflare_zero_trust_tunnel_cloudflared_config.app.config.ingress[0].service == "http://web:8080"
      && cloudflare_zero_trust_tunnel_cloudflared_config.app.config.ingress[1].service == "http_status:404"
    )
    error_message = "The remote tunnel must route only the public app hostname to the private web service and reject unmatched traffic."
  }

  assert {
    condition     = !cloudflare_dns_record.game.proxied && cloudflare_dns_record.game.ttl == 300
    error_message = "The UDP game/GOTV record must bypass the Cloudflare HTTP proxy."
  }

  assert {
    condition     = !cloudflare_r2_managed_domain.demos.enabled
    error_message = "The demo bucket must not expose its r2.dev managed domain."
  }
}

run "hillsboro_route" {
  command = plan

  variables {
    game_subdomain = "game-na-west"
    route_label    = "NA West"
  }

  assert {
    condition     = output.game_endpoint == "game-na-west.legacy-match.example:27115"
    error_message = "The Hillsboro alternative must publish the NA West hostname."
  }

  assert {
    condition     = output.latency_probe_endpoints == "NA West=game-na-west.legacy-match.example:27125"
    error_message = "The launcher route output must stay aligned with the selected region label."
  }
}
