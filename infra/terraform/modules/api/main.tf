# API no ECS (T8.2 e T8.4): ALB público só com HTTPS e AWS WAF na frente, serviço Fargate em subnet privada e as
# tarefas avulsas do deploy (bootstrap dos papéis de banco e migrations). Imagens de apps/api/Dockerfile.
#
# - Segredos (URLs de banco por papel, chaves de sessão e de CSRF) gerados aqui e gravados por write-only: não passam
#   pelo state. O ECS injeta cada um só na tarefa que precisa, em tempo de execução.
# - Um papel de execução por tarefa (cada um lê só os próprios segredos) e um papel de tarefa só para a API.
# - Serviço e tarefas só existem quando o deploy (T8.5) informa os digests das imagens publicadas no ECR.

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

variable "name" {
  description = "Prefixo dos recursos (ex.: verax-control-production)."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_ids" {
  description = "Subnets públicas (só o ALB)."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnets privadas (API e tarefas)."
  type        = list(string)
}

variable "data_kms_key_arn" {
  type = string
}

variable "logs_kms_key_arn" {
  type = string
}

variable "api_domain" {
  description = "Domínio da API (pendência 4)."
  type        = string
}

variable "panel_domain" {
  description = "Domínio do painel (única origem aceita pela API)."
  type        = string
}

variable "dns_zone_id" {
  description = "Zona pública do Route53. Nula: validação do certificado e apontamento à mão no DNS."
  type        = string
  default     = null
}

variable "mail_from" {
  description = "Remetente dos e-mails de redefinição de senha (identidade verificada no SES)."
  type        = string
}

variable "database_endpoint" {
  type = string
}

variable "database_security_group_id" {
  type = string
}

variable "database_master_secret_arn" {
  description = "Segredo da senha mestra (gerenciado pelo RDS), lido só pela tarefa de bootstrap."
  type        = string
}

variable "indexer_security_group_id" {
  description = "Security group do Wazuh, para a API ler os alertas (nulo onde não há Wazuh, como no staging)."
  type        = string
  default     = null
}

variable "api_image_digest" {
  description = "Digest da imagem da API no ECR (sha256:...), informado pelo deploy. Nulo: sem serviço nem tarefas."
  type        = string
  default     = null
}

variable "migrate_image_digest" {
  description = "Digest da imagem de migrations no ECR, informado pelo deploy."
  type        = string
  default     = null
}

variable "desired_count" {
  description = "Tarefas da API em execução."
  type        = number
  default     = 2
}

variable "secret_version" {
  description = "Aumente para gerar novas senhas de banco e chaves (rotação); depois rode o deploy."
  type        = number
  default     = 1
}

variable "deletion_protection" {
  description = "Protege o ALB contra exclusão."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 365
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${data.aws_region.current.region}.s3"
}

locals {
  region      = data.aws_region.current.region
  account     = data.aws_caller_identity.current.account_id
  partition   = data.aws_partition.current.partition
  enabled     = var.api_image_digest != null && var.migrate_image_digest != null
  with_dns    = var.dns_zone_id != null
  rds_ca      = "/etc/ssl/rds/global-bundle.pem"
  db_url      = "@${var.database_endpoint}:5432/verax?sslmode=verify-full&sslrootcert=${local.rds_ca}"
  mail_domain = split("@", var.mail_from)[1]
}

# --- Imagens ---

resource "aws_ecr_repository" "this" {
  for_each             = toset(["api", "api-migrate"])
  name                 = "${var.name}-${each.value}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.data_kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Mantém as 20 imagens mais recentes"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# --- Segredos ---

# Geradas pela AWS a cada plan/apply, sem ir para o state; só são gravadas quando secret_version muda.
ephemeral "aws_secretsmanager_random_password" "db_app" {
  password_length     = 40
  exclude_punctuation = true
  include_space       = false
}

ephemeral "aws_secretsmanager_random_password" "db_migrator" {
  password_length     = 40
  exclude_punctuation = true
  include_space       = false
}

ephemeral "aws_secretsmanager_random_password" "auth" {
  password_length     = 64
  exclude_punctuation = true
  include_space       = false
}

ephemeral "aws_secretsmanager_random_password" "csrf" {
  password_length     = 64
  exclude_punctuation = true
  include_space       = false
}

resource "aws_secretsmanager_secret" "this" {
  #checkov:skip=CKV2_AWS_57:Rotação versionada (secret_version) aplicada pelo deploy: o bootstrap atualiza a senha no banco e o serviço é recriado com o valor novo.
  for_each = {
    db-url-app      = "URL do banco com o papel da aplicação (verax_app)"
    db-url-migrator = "URL do banco com o papel das migrations (verax_migrator)"
    api-auth        = "Chaves da API: sessão (Better Auth) e CSRF"
  }
  name                    = "${var.name}/${each.key}"
  description             = each.value
  kms_key_id              = var.data_kms_key_arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "db_app" {
  secret_id                = aws_secretsmanager_secret.this["db-url-app"].id
  secret_string_wo         = "postgresql://verax_app:${ephemeral.aws_secretsmanager_random_password.db_app.random_password}${local.db_url}"
  secret_string_wo_version = var.secret_version
}

resource "aws_secretsmanager_secret_version" "db_migrator" {
  secret_id                = aws_secretsmanager_secret.this["db-url-migrator"].id
  secret_string_wo         = "postgresql://verax_migrator:${ephemeral.aws_secretsmanager_random_password.db_migrator.random_password}${local.db_url}"
  secret_string_wo_version = var.secret_version
}

resource "aws_secretsmanager_secret_version" "api_auth" {
  secret_id = aws_secretsmanager_secret.this["api-auth"].id
  secret_string_wo = jsonencode({
    better_auth_secret = ephemeral.aws_secretsmanager_random_password.auth.random_password
    csrf_secret        = ephemeral.aws_secretsmanager_random_password.csrf.random_password
  })
  secret_string_wo_version = var.secret_version
}

# --- Logs ---

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(["api", "migrate", "db-bootstrap"])
  name              = "/verax-control/${var.name}/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

# --- Papéis ---

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

locals {
  # Segredos que cada tarefa recebe (lidos pelo papel de execução dela, e só por ele).
  execution_secrets = {
    api          = [aws_secretsmanager_secret.this["db-url-app"].arn, aws_secretsmanager_secret.this["api-auth"].arn]
    migrate      = [aws_secretsmanager_secret.this["db-url-migrator"].arn]
    db-bootstrap = [var.database_master_secret_arn, aws_secretsmanager_secret.this["db-url-app"].arn, aws_secretsmanager_secret.this["db-url-migrator"].arn]
  }
}

resource "aws_iam_role" "execution" {
  for_each           = local.execution_secrets
  name               = "${var.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each   = aws_iam_role.execution
  role       = each.value.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  for_each = local.execution_secrets

  statement {
    sid       = "LerSoOsSegredosDestaTarefa"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value
  }

  statement {
    sid       = "DecifrarViaSecretsManager"
    actions   = ["kms:Decrypt"]
    resources = [var.data_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = local.execution_secrets
  name     = "segredos"
  role     = aws_iam_role.execution[each.key].id
  policy   = data.aws_iam_policy_document.execution_secrets[each.key].json
}

# Papel da API em execução. O nome bate com o prefixo que o conector do cliente aceita (verax-control-production-*).
# Bootstrap e migrations não recebem papel de tarefa: não chamam a AWS.
resource "aws_iam_role" "api_task" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

data "aws_iam_policy_document" "api_task" {
  statement {
    sid       = "EnviarEmailsSoPeloDominio"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [aws_sesv2_email_identity.mail.arn]
  }

  statement {
    sid       = "AssumirPapelDosClientes"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:${local.partition}:iam::*:role/VeraxControlReadOnly"]
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "api"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

# --- E-mail ---

resource "aws_sesv2_email_identity" "mail" {
  email_identity = local.mail_domain
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "dkim" {
  count   = local.with_dns ? 3 : 0
  zone_id = var.dns_zone_id
  name    = "${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.mail_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# --- Rede ---

resource "aws_security_group" "alb" {
  name        = "${var.name}-api-alb"
  description = "ALB da API: so HTTPS da internet; saida so para a API"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-api-alb" }
}

# Exceção à regra AWS-0107 do Trivy (entrada da internet): é a porta pública da API, só HTTPS, atrás do AWS WAF.
# Sem porta 80: o painel sempre chama a API por HTTPS (e o HSTS do painel garante isso no navegador).
#trivy:ignore:AWS-0107
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS da internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Para a API"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "API: entrada so do ALB; saida para banco, indexer e HTTPS"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-api" }
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "Do ALB"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.alb.id
}

# Exceção à regra AWS-0104 do Trivy: a API fala com o SES, com o Have I Been Pwned (senhas vazadas) e com as APIs
# públicas da AWS nas contas dos clientes, sem CIDR fixo. Só a porta 443, pelo NAT, com flow logs.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  description       = "HTTPS (SES, Have I Been Pwned, APIs da AWS)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "api_db" {
  security_group_id            = aws_security_group.api.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.database_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "api_indexer" {
  count                        = var.indexer_security_group_id == null ? 0 : 1
  security_group_id            = aws_security_group.api.id
  description                  = "Indexer do Wazuh"
  ip_protocol                  = "tcp"
  from_port                    = 9200
  to_port                      = 9200
  referenced_security_group_id = var.indexer_security_group_id
}

# Bootstrap e migrations: só o banco e os endpoints privados da AWS (imagem, segredos e logs), sem internet.
resource "aws_security_group" "jobs" {
  #checkov:skip=CKV2_AWS_5:Ligado às tarefas de bootstrap e migrations no run-task do deploy (T8.5), que o checkov não vê.
  name        = "${var.name}-api-jobs"
  description = "Tarefas do deploy: so banco e endpoints privados"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-api-jobs" }
}

resource "aws_vpc_security_group_egress_rule" "jobs_db" {
  security_group_id            = aws_security_group.jobs.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.database_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "jobs_endpoints" {
  security_group_id = aws_security_group.jobs.id
  description       = "Endpoints privados da AWS (ECR, Secrets Manager, Logs)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "jobs_s3" {
  security_group_id = aws_security_group.jobs.id
  description       = "Camadas das imagens no S3 (endpoint gateway)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
}

# --- Log de acesso do ALB ---

# O log de acesso do ALB só aceita SSE-S3 (documentação da AWS): por isso este bucket não usa o private-bucket.
resource "aws_s3_bucket" "alb_logs" {
  #checkov:skip=CKV_AWS_145:O log de acesso do ALB só é entregue em bucket com SSE-S3, não com KMS.
  #checkov:skip=CKV_AWS_144:Replicação entre regiões fora do MVP.
  #checkov:skip=CKV2_AWS_62:Sem consumidores de eventos de bucket no MVP.
  #checkov:skip=CKV_AWS_18:É o próprio destino de logs; registrar o acesso a ele criaria um ciclo.
  bucket = "${var.name}-api-alb-logs-${local.account}"
}

resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Exceção à regra AWS-0132 do Trivy (chave do cliente): o log de acesso do ALB só aceita SSE-S3.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "retencao"
    status = "Enabled"
    filter {}
    expiration {
      days = var.log_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "alb_logs" {
  statement {
    sid       = "EntregaDoLogDoAlb"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/AWSLogs/${local.account}/*"]
    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:elasticloadbalancing:${local.region}:${local.account}:loadbalancer/*"]
    }
  }

  statement {
    sid       = "SomenteTLS"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.alb_logs.arn, "${aws_s3_bucket.alb_logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket     = aws_s3_bucket.alb_logs.id
  policy     = data.aws_iam_policy_document.alb_logs.json
  depends_on = [aws_s3_bucket_public_access_block.alb_logs]
}

# --- Certificado ---

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = local.with_dns ? {
    for option in aws_acm_certificate.api.domain_validation_options : option.domain_name => option
  } : {}
  zone_id = var.dns_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = local.with_dns ? [for record in aws_route53_record.validation : record.fqdn] : null
}

# --- ALB ---

# Exceção à regra AWS-0053 do Trivy (load balancer público): é a entrada da API na internet, atrás do AWS WAF.
#trivy:ignore:AWS-0053
resource "aws_lb" "api" {
  #checkov:skip=CKV2_AWS_76:O WAF associado (aws_wafv2_web_acl_association) tem a regra de Log4j (KnownBadInputs); o grafo do checkov não liga a associação.
  name                       = substr("${var.name}-api", 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  desync_mitigation_mode     = "strictest"

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.alb_logs]
}

resource "aws_lb_target_group" "api" {
  name                 = substr("${var.name}-api", 0, 32)
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_route53_record" "api" {
  for_each = local.with_dns ? toset(["A", "AAAA"]) : toset([])
  zone_id  = var.dns_zone_id
  name     = var.api_domain
  type     = each.value
  alias {
    name                   = aws_lb.api.dns_name
    zone_id                = aws_lb.api.zone_id
    evaluate_target_health = true
  }
}

# --- WAF ---

resource "aws_wafv2_web_acl" "api" {
  name        = "${var.name}-api"
  description = "API: regras gerenciadas da AWS e limites por IP"
  scope       = "REGIONAL"

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
        # O limite de corpo da API é 100 kB (validado na própria API); a regra de 8 kB só conta.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
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
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 40
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesSQLiRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesSQLiRuleSet"
      sampled_requests_enabled   = true
    }
  }

  # Autenticação: limite bem menor por IP, além do limite e do bloqueio por conta da própria API.
  rule {
    name     = "limite-autenticacao"
    priority = 50
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/v1/auth/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "limite-autenticacao"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "limite-por-ip"
    priority = 60
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 1000
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
    metric_name                = "${var.name}-api"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_lb.api.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}

resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${var.name}-api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

resource "aws_wafv2_web_acl_logging_configuration" "api" {
  resource_arn            = aws_wafv2_web_acl.api.arn
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

# --- ECS ---

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-api"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  repository_url = { for key, repo in aws_ecr_repository.this : key => repo.repository_url }

  hardened_container = {
    essential              = true
    user                   = "1000"
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    linuxParameters        = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } }
  }

  log_configuration = { for key, group in aws_cloudwatch_log_group.this : key => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = group.name
      awslogs-region        = local.region
      awslogs-stream-prefix = key
    }
  } }

  db_secrets = {
    app      = aws_secretsmanager_secret.this["db-url-app"].arn
    migrator = aws_secretsmanager_secret.this["db-url-migrator"].arn
  }
}

resource "aws_ecs_task_definition" "api" {
  count                    = local.enabled ? 1 : 0
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution["api"].arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.hardened_container, {
    name             = "api"
    image            = "${local.repository_url["api"]}@${var.api_image_digest}"
    portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
    logConfiguration = local.log_configuration["api"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "LOG_LEVEL", value = "info" },
      { name = "TRUST_PROXY_HOPS", value = "1" },
      { name = "WEB_ORIGIN", value = "https://${var.panel_domain}" },
      { name = "API_ORIGIN", value = "https://${var.api_domain}" },
      { name = "AUTH_RATE_LIMIT_ENABLED", value = "true" },
      { name = "PASSWORD_BREACH_CHECK_ENABLED", value = "true" },
      { name = "MAIL_TRANSPORT", value = "ses" },
      { name = "MAIL_FROM", value = var.mail_from },
      { name = "AWS_REGION", value = local.region },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.db_secrets.app },
      { name = "BETTER_AUTH_SECRET", valueFrom = "${aws_secretsmanager_secret.this["api-auth"].arn}:better_auth_secret::" },
      { name = "CSRF_SECRET", valueFrom = "${aws_secretsmanager_secret.this["api-auth"].arn}:csrf_secret::" },
    ]
    healthCheck = {
      command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  })])
}

resource "aws_ecs_task_definition" "migrate" {
  count                    = local.enabled ? 1 : 0
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["migrate"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.hardened_container, {
    name             = "migrate"
    image            = "${local.repository_url["api-migrate"]}@${var.migrate_image_digest}"
    logConfiguration = local.log_configuration["migrate"]
    environment      = [{ name = "NODE_ENV", value = "production" }]
    secrets          = [{ name = "DATABASE_URL", valueFrom = local.db_secrets.migrator }]
  })])
}

resource "aws_ecs_task_definition" "db_bootstrap" {
  count                    = local.enabled ? 1 : 0
  family                   = "${var.name}-db-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["db-bootstrap"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.hardened_container, {
    name             = "db-bootstrap"
    image            = "${local.repository_url["api"]}@${var.api_image_digest}"
    command          = ["node", "dist/cli/db-bootstrap.js"]
    logConfiguration = local.log_configuration["db-bootstrap"]
    environment      = [{ name = "NODE_ENV", value = "production" }]
    secrets = [
      { name = "DB_MASTER_USERNAME", valueFrom = "${var.database_master_secret_arn}:username::" },
      { name = "DB_MASTER_PASSWORD", valueFrom = "${var.database_master_secret_arn}:password::" },
      { name = "MIGRATOR_DATABASE_URL", valueFrom = local.db_secrets.migrator },
      { name = "DATABASE_URL", valueFrom = local.db_secrets.app },
    ]
  })])
}

resource "aws_ecs_service" "api" {
  count                             = local.enabled ? 1 : 0
  name                              = "api"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.api[0].arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = 60
  enable_execute_command            = false
  propagate_tags                    = "SERVICE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # A revisão em uso é trocada pelo deploy (T8.5), que clona a revisão mais recente trocando só a imagem. O Terraform
  # não volta o serviço para uma imagem antiga; uma mudança de endurecimento aqui entra na próxima versão publicada.
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener.https]
}

output "repository_urls" {
  value = local.repository_url
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "api_security_group_id" {
  value = aws_security_group.api.id
}

output "jobs_security_group_id" {
  description = "Security group das tarefas de bootstrap e migrations (o deploy usa no run-task)."
  value       = aws_security_group.jobs.id
}

output "private_subnet_ids" {
  value = var.private_subnet_ids
}

output "task_definition_families" {
  description = "Famílias das tarefas que o deploy roda, na ordem: bootstrap, migrations, bootstrap."
  value = {
    db_bootstrap = "${var.name}-db-bootstrap"
    migrate      = "${var.name}-migrate"
  }
}

output "alb_dns_name" {
  description = "Destino do CNAME do domínio da API, quando o DNS não está no Route53."
  value       = aws_lb.api.dns_name
}

output "certificate_validation_records" {
  value = [for option in aws_acm_certificate.api.domain_validation_options : {
    name  = option.resource_record_name
    type  = option.resource_record_type
    value = option.resource_record_value
  }]
}

output "ses_dkim_records" {
  description = "Registros DKIM do domínio de e-mail (criar à mão quando o DNS não está no Route53)."
  value = [for token in aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens : {
    name  = "${token}._domainkey.${local.mail_domain}"
    type  = "CNAME"
    value = "${token}.dkim.amazonses.com"
  }]
}

output "repository_arns" {
  value = [for repo in aws_ecr_repository.this : repo.arn]
}

output "deploy_pass_role_arns" {
  description = "Papéis que as revisões das tarefas usam (o deploy só pode passar estes)."
  value       = concat([for role in aws_iam_role.execution : role.arn], [aws_iam_role.api_task.arn])
}

output "job_log_groups" {
  value = { for key in ["db-bootstrap", "migrate"] : key => aws_cloudwatch_log_group.this[key].name }
}

output "job_log_group_arns" {
  value = [for key in ["db-bootstrap", "migrate"] : aws_cloudwatch_log_group.this[key].arn]
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "alb_arn_suffix" {
  value = aws_lb.api.arn_suffix
}

output "target_group_arn_suffix" {
  value = aws_lb_target_group.api.arn_suffix
}
