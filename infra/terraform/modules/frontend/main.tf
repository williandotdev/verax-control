# Front do painel (T8.3): build estático do apps/web num bucket privado, servido só pelo CloudFront (OAC), com os
# mesmos cabeçalhos de segurança do `vite preview` (apps/web/src/build-guards.ts), domínio próprio com TLS e AWS WAF.
#
# Certificado, WAF e logs do CloudFront precisam estar em us-east-1: o módulo recebe o provider `aws.us_east_1`.
# Sem zona DNS no Route53 (`dns_zone_id` nulo), a validação do certificado e o apontamento do domínio são feitos à
# mão no DNS (README de infra/terraform).

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 6.0, < 7.0"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

variable "name" {
  description = "Prefixo dos recursos (ex.: verax-control-production)."
  type        = string
}

variable "panel_domain" {
  description = "Domínio do painel (ex.: painel.exemplo.com.br), pendência 4."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.panel_domain))
    error_message = "Informe um domínio, como painel.exemplo.com.br."
  }
}

variable "api_domain" {
  description = "Domínio da API (entra no connect-src da CSP)."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.api_domain))
    error_message = "Informe um domínio, como api.exemplo.com.br."
  }
}

variable "dns_zone_id" {
  description = "Zona pública do Route53 do domínio. Nula: validação e apontamento feitos à mão no DNS."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "Retenção dos logs do CloudFront e do WAF."
  type        = number
  default     = 365
}

variable "rate_limit_per_5_minutes" {
  description = "Requisições por IP em 5 minutos antes do bloqueio no WAF."
  type        = number
  default     = 2000
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

locals {
  account     = data.aws_caller_identity.current.account_id
  partition   = data.aws_partition.current.partition
  bucket_name = "${var.name}-panel-${local.account}"
  with_dns    = var.dns_zone_id != null

  # Mesma política do `vite preview` (contentSecurityPolicy em apps/web/src/build-guards.ts).
  csp = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://${var.api_domain}",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ])
}

# --- Arquivos do painel ---

resource "aws_kms_key" "assets" {
  description             = "${var.name}: arquivos do painel (lidos pelo CloudFront)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "assets" {
  name          = "alias/${var.name}-panel"
  target_key_id = aws_kms_key.assets.key_id
}

# Política aplicada depois da distribuição existir: o CloudFront só decifra para esta distribuição.
data "aws_iam_policy_document" "assets_key" {
  #checkov:skip=CKV_AWS_356:Política de chave KMS: "*" é a própria chave; padrão da AWS para delegar ao IAM da conta.
  #checkov:skip=CKV_AWS_111:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  #checkov:skip=CKV_AWS_109:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }

  statement {
    sid       = "CloudFrontDestaDistribuicao"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.panel.arn]
    }
  }
}

resource "aws_kms_key_policy" "assets" {
  key_id = aws_kms_key.assets.id
  policy = data.aws_iam_policy_document.assets_key.json
}

data "aws_iam_policy_document" "oac" {
  statement {
    sid       = "SoEstaDistribuicaoDoCloudFront"
    actions   = ["s3:GetObject"]
    resources = ["arn:${local.partition}:s3:::${local.bucket_name}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.panel.arn]
    }
  }
}

module "assets_bucket" {
  source            = "../private-bucket"
  name              = local.bucket_name
  kms_key_arn       = aws_kms_key.assets.arn
  extra_policy_json = data.aws_iam_policy_document.oac.json
}

# --- Logs em us-east-1 (CloudFront e WAF) ---

data "aws_iam_policy_document" "logs_key" {
  #checkov:skip=CKV_AWS_356:Política de chave KMS: "*" é a própria chave; padrão da AWS para delegar ao IAM da conta.
  #checkov:skip=CKV_AWS_111:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  #checkov:skip=CKV_AWS_109:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }

  statement {
    sid       = "CloudWatchLogsDaConta"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.us-east-1.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:us-east-1:${local.account}:*"]
    }
  }
}

resource "aws_kms_key" "edge_logs" {
  provider                = aws.us_east_1
  description             = "${var.name}: logs do CloudFront e do WAF do painel"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.logs_key.json
}

resource "aws_cloudwatch_log_group" "cloudfront" {
  provider          = aws.us_east_1
  name              = "/verax-control/${var.name}/cloudfront-panel"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.edge_logs.arn
}

# Log de acesso do CloudFront (versão 2, pela entrega de logs do CloudWatch).
resource "aws_cloudwatch_log_delivery_source" "cloudfront" {
  provider     = aws.us_east_1
  name         = "${var.name}-cloudfront-panel"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.panel.arn
}

resource "aws_cloudwatch_log_delivery_destination" "cloudfront" {
  provider = aws.us_east_1
  name     = "${var.name}-cloudfront-panel"
  delivery_destination_configuration {
    destination_resource_arn = aws_cloudwatch_log_group.cloudfront.arn
  }
}

resource "aws_cloudwatch_log_delivery" "cloudfront" {
  provider                 = aws.us_east_1
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.cloudfront.arn
}

# --- WAF ---

resource "aws_wafv2_web_acl" "panel" {
  provider    = aws.us_east_1
  name        = "${var.name}-panel"
  description = "Painel: regras gerenciadas da AWS e limite por IP"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesAmazonIpReputationList"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  # Entradas maliciosas conhecidas, incluindo o Log4Shell (CVE-2021-44228).
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 30
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesKnownBadInputsRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "limite-por-ip"
    priority = 40
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5_minutes
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "limite-por-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-panel"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudwatch_log_group" "waf" {
  provider          = aws.us_east_1
  name              = "aws-waf-logs-${var.name}-panel"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.edge_logs.arn
}

resource "aws_wafv2_web_acl_logging_configuration" "panel" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.panel.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  # Credenciais dos usuários nunca vão para o log.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
}

# --- Certificado e DNS ---

resource "aws_acm_certificate" "panel" {
  provider          = aws.us_east_1
  domain_name       = var.panel_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = local.with_dns ? {
    for option in aws_acm_certificate.panel.domain_validation_options : option.domain_name => option
  } : {}
  zone_id = var.dns_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

# Sem zona no Route53, espera os registros criados à mão (saída `certificate_validation_records`).
resource "aws_acm_certificate_validation" "panel" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.panel.arn
  validation_record_fqdns = local.with_dns ? [for record in aws_route53_record.validation : record.fqdn] : null
}

# --- Distribuição ---

resource "aws_cloudfront_origin_access_control" "panel" {
  name                              = "${var.name}-panel"
  description                       = "Leitura do bucket do painel pelo CloudFront"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Rotas do React Router (sem extensão) recebem o index.html; arquivos (com extensão) seguem para o bucket.
resource "aws_cloudfront_function" "spa" {
  name    = "${var.name}-panel-spa"
  runtime = "cloudfront-js-2.0"
  comment = "Rotas do painel para o index.html"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      if (!request.uri.includes('.')) {
        request.uri = '/index.html';
      }
      return request;
    }
  EOT
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${var.name}-panel-security"
  comment = "Cabeçalhos de segurança do painel (iguais aos do vite preview)"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.csp
      override                = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "panel" {
  #checkov:skip=CKV_AWS_86:Log de acesso pela entrega de logs do CloudWatch (versão 2), que o checkov não reconhece.
  #checkov:skip=CKV_AWS_310:Uma só origem (o bucket); não há para onde fazer failover.
  #checkov:skip=CKV_AWS_374:Sem restrição geográfica: os clientes podem acessar de fora do Brasil.
  #checkov:skip=CKV2_AWS_47:O WAF ligado (web_acl_id) tem a regra de Log4j (CKV_AWS_192 passa nele); o grafo do checkov não liga os dois pelo provider de us-east-1.
  enabled             = true
  comment             = "Painel do Verax Control (${var.name})"
  aliases             = [var.panel_domain]
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_All"
  web_acl_id          = aws_wafv2_web_acl.panel.arn

  origin {
    origin_id                = "painel"
    domain_name              = module.assets_bucket.regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.panel.id
  }

  default_cache_behavior {
    target_origin_id           = "painel"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.panel.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "panel" {
  for_each = local.with_dns ? toset(["A", "AAAA"]) : toset([])
  zone_id  = var.dns_zone_id
  name     = var.panel_domain
  type     = each.value
  alias {
    name                   = aws_cloudfront_distribution.panel.domain_name
    zone_id                = aws_cloudfront_distribution.panel.hosted_zone_id
    evaluate_target_health = false
  }
}

output "bucket" {
  description = "Bucket do build do painel (publicado pelo deploy, T8.5)."
  value       = module.assets_bucket.id
}

output "assets_kms_key_arn" {
  value = aws_kms_key.assets.arn
}

output "distribution_id" {
  value = aws_cloudfront_distribution.panel.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.panel.arn
}

output "distribution_domain" {
  description = "Destino do CNAME do domínio do painel, quando o DNS não está no Route53."
  value       = aws_cloudfront_distribution.panel.domain_name
}

output "certificate_validation_records" {
  description = "Registros DNS que validam o certificado (criar à mão quando o DNS não está no Route53)."
  value = [for option in aws_acm_certificate.panel.domain_validation_options : {
    name  = option.resource_record_name
    type  = option.resource_record_type
    value = option.resource_record_value
  }]
}

output "bucket_arn" {
  value = module.assets_bucket.arn
}
