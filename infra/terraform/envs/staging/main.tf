# Ambiente de staging: pequeno, sem Wazuh e só com dados fictícios (pendência 7), para que dado real de
# cliente nunca chegue aqui.

variable "aws_region" {
  description = "Região da conta Verax."
  type        = string
  default     = "sa-east-1"
}

variable "availability_zones" {
  description = "Zonas fixadas (a lista não muda sozinha quando a AWS cria uma zona nova)."
  type        = list(string)
  default     = ["sa-east-1a", "sa-east-1b"]
}

variable "vpc_cidr" {
  description = "Faixa da VPC de staging."
  type        = string
  default     = "10.40.0.0/16"
}

variable "panel_domain" {
  description = "Domínio do painel (pendência 4)."
  type        = string
}

variable "api_domain" {
  description = "Domínio da API (pendência 4)."
  type        = string
}

variable "mail_from" {
  description = "Remetente dos e-mails do painel (ex.: nao-responda@exemplo.com.br); o domínio é verificado no SES."
  type        = string
}

variable "api_image_digest" {
  description = "Digest da imagem da API no ECR, informado pelo deploy (T8.5). Nulo: sem serviço."
  type        = string
  default     = null
}

variable "migrate_image_digest" {
  description = "Digest da imagem de migrations no ECR, informado pelo deploy (T8.5)."
  type        = string
  default     = null
}

variable "alarm_email" {
  description = "E-mail que recebe os alarmes (fica no terraform.tfvars local, fora do git)."
  type        = string
  default     = null
}

variable "dns_zone_id" {
  description = "Zona pública do Route53 dos domínios. Nula: validação e apontamento à mão no DNS."
  type        = string
  default     = null
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "verax-control"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# Recursos globais do CloudFront (certificado, WAF e logs) só existem em us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = "verax-control"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  name = "verax-control-staging"
}

module "kms" {
  source = "../../modules/kms"
  name   = local.name
}

module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr_block         = var.vpc_cidr
  availability_zones = var.availability_zones
  nat_gateways       = 1
  logs_kms_key_arn   = module.kms.logs_key_arn
  log_retention_days = 365
}

module "database" {
  source                = "../../modules/database"
  name                  = local.name
  vpc_id                = module.network.vpc_id
  private_subnet_ids    = module.network.private_subnet_ids
  data_kms_key_arn      = module.kms.data_key_arn
  logs_kms_key_arn      = module.kms.logs_key_arn
  instance_class        = "db.t4g.micro"
  multi_az              = false
  backup_retention_days = 7
  # Staging só tem dados fictícios e pode ser recriado.
  deletion_protection = false
  client_security_groups = {
    api  = module.api.api_security_group_id
    jobs = module.api.jobs_security_group_id
  }
}

module "api" {
  source                     = "../../modules/api"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  vpc_cidr                   = module.network.vpc_cidr
  public_subnet_ids          = module.network.public_subnet_ids
  private_subnet_ids         = module.network.private_subnet_ids
  data_kms_key_arn           = module.kms.data_key_arn
  logs_kms_key_arn           = module.kms.logs_key_arn
  api_domain                 = var.api_domain
  panel_domain               = var.panel_domain
  dns_zone_id                = var.dns_zone_id
  mail_from                  = var.mail_from
  database_endpoint          = module.database.endpoint
  database_security_group_id = module.database.security_group_id
  database_master_secret_arn = module.database.master_secret_arn
  api_image_digest           = var.api_image_digest
  migrate_image_digest       = var.migrate_image_digest
  desired_count              = 1
  deletion_protection        = false
}

module "frontend" {
  source = "../../modules/frontend"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  name         = local.name
  panel_domain = var.panel_domain
  api_domain   = var.api_domain
  dns_zone_id  = var.dns_zone_id
}

module "deploy" {
  source             = "../../modules/deploy-role"
  name               = local.name
  environment        = "staging"
  cluster_arn        = module.api.cluster_arn
  repository_arns    = module.api.repository_arns
  pass_role_arns     = module.api.deploy_pass_role_arns
  job_log_group_arns = module.api.job_log_group_arns
  panel_bucket_arn   = module.frontend.bucket_arn
  panel_kms_key_arn  = module.frontend.assets_kms_key_arn
  distribution_arn   = module.frontend.distribution_arn
  release_config = {
    region                   = var.aws_region
    cluster                  = module.api.cluster_name
    service                  = "api"
    api_repository           = module.api.repository_urls["api"]
    migrate_repository       = module.api.repository_urls["api-migrate"]
    task_family_api          = "${local.name}-api"
    task_family_migrate      = "${local.name}-migrate"
    task_family_db_bootstrap = "${local.name}-db-bootstrap"
    subnets                  = join(",", module.api.private_subnet_ids)
    jobs_security_group      = module.api.jobs_security_group_id
    log_group_db_bootstrap   = module.api.job_log_groups["db-bootstrap"]
    log_group_migrate        = module.api.job_log_groups["migrate"]
    panel_bucket             = module.frontend.bucket
    distribution_id          = module.frontend.distribution_id
    api_domain               = var.api_domain
    panel_domain             = var.panel_domain
  }
}

module "monitoring" {
  source                  = "../../modules/monitoring"
  name                    = local.name
  alarm_email             = var.alarm_email
  alb_arn_suffix          = module.api.alb_arn_suffix
  target_group_arn_suffix = module.api.target_group_arn_suffix
  api_cluster_name        = module.api.cluster_name
  api_desired_count       = 1
  database_identifier     = module.database.identifier

  watched_cluster_arns = [module.api.cluster_arn]
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "panel_bucket" {
  value = module.frontend.bucket
}

output "panel_distribution_domain" {
  value = module.frontend.distribution_domain
}

output "panel_certificate_validation_records" {
  value = module.frontend.certificate_validation_records
}

output "api_repository_urls" {
  value = module.api.repository_urls
}

output "api_certificate_validation_records" {
  value = module.api.certificate_validation_records
}

output "api_alb_dns_name" {
  value = module.api.alb_dns_name
}

output "ses_dkim_records" {
  value = module.api.ses_dkim_records
}

output "deploy_role_arn" {
  description = "Valor da variável AWS_DEPLOY_ROLE_ARN do environment no GitHub."
  value       = module.deploy.role_arn
}

output "alarm_topic_arn" {
  value = module.monitoring.alarm_topic_arn
}
