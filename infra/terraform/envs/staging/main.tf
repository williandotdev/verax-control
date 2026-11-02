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

output "vpc_id" {
  value = module.network.vpc_id
}
