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
