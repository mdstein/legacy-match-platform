variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the R2 bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hexadecimal ID."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the selected public domain."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a 32-character lowercase hexadecimal ID."
  }
}

variable "domain" {
  description = "Apex domain already active in the selected Cloudflare zone."
  type        = string

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", lower(trimspace(var.domain))))
    error_message = "domain must be a lowercase-compatible DNS name such as example.com, without a trailing dot."
  }
}

variable "app_subdomain" {
  description = "DNS label for the browser application."
  type        = string
  default     = "play"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", var.app_subdomain))
    error_message = "app_subdomain must be one valid lowercase DNS label."
  }
}

variable "tunnel_name" {
  description = "Account-unique name for the remotely managed application tunnel."
  type        = string
  default     = "legacy-match-private-alpha"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.tunnel_name))
    error_message = "tunnel_name must contain 3-63 lowercase letters, numbers, or hyphens and start/end with a letter or number."
  }
}

variable "game_subdomain" {
  description = "DNS label for the direct UDP game and GOTV endpoint."
  type        = string
  default     = "game-na-east"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", var.game_subdomain))
    error_message = "game_subdomain must be one valid lowercase DNS label."
  }
}

variable "game_origin_ipv4" {
  description = "Public IPv4 address of the Windows game node."
  type        = string

  validation {
    condition     = can(cidrnetmask("${var.game_origin_ipv4}/32"))
    error_message = "game_origin_ipv4 must be a valid IPv4 address."
  }
}

variable "route_label" {
  description = "Player-visible latency route name."
  type        = string
  default     = "NA East"

  validation {
    condition     = contains(["NA East", "NA Central", "NA West"], var.route_label)
    error_message = "route_label must be NA East, NA Central, or NA West."
  }
}

variable "game_port" {
  description = "Public UDP port for the legacy CS:GO server."
  type        = number
  default     = 27115

  validation {
    condition     = var.game_port >= 1024 && var.game_port <= 65535
    error_message = "game_port must be between 1024 and 65535."
  }
}

variable "gotv_port" {
  description = "Public UDP port for GOTV."
  type        = number
  default     = 27120

  validation {
    condition     = var.gotv_port >= 1024 && var.gotv_port <= 65535 && var.gotv_port != var.game_port
    error_message = "gotv_port must be between 1024 and 65535 and differ from game_port."
  }
}

variable "latency_probe_port" {
  description = "Always-on public UDP port for launcher latency measurement."
  type        = number
  default     = 27125

  validation {
    condition = (
      var.latency_probe_port >= 1024
      && var.latency_probe_port <= 65535
      && var.latency_probe_port != var.game_port
      && var.latency_probe_port != var.gotv_port
    )
    error_message = "latency_probe_port must be between 1024 and 65535 and differ from game_port and gotv_port."
  }
}

variable "demo_bucket_name" {
  description = "Globally unique private R2 bucket for match demos and evidence."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.demo_bucket_name))
    error_message = "demo_bucket_name must contain 3-63 lowercase letters, numbers, or hyphens and start/end with a letter or number."
  }
}
