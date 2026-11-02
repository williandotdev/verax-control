# Ambiente de produção: duas zonas com um NAT gateway em cada, retenção longa de logs e o Wazuh (T4.2).

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
  description = "Faixa da VPC de produção."
  type        = string
  default     = "10.50.0.0/16"
}

variable "prowler_image_digest" {
  description = "Digest da imagem do Prowler no ECR, informado pelo deploy (E8). Nulo: sem tarefa agendada."
  type        = string
  default     = null
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "verax-control"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  name = "verax-control-production"
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
  nat_gateways       = 2
  logs_kms_key_arn   = module.kms.logs_key_arn
  log_retention_days = 365
}

module "wazuh" {
  source            = "../../modules/wazuh"
  name              = local.name
  vpc_id            = module.network.vpc_id
  subnet_id         = module.network.private_subnet_ids[0]
  private_zone_id   = module.network.private_zone_id
  private_zone_name = module.network.private_zone_name
  data_kms_key_arn  = module.kms.data_key_arn
  logs_kms_key_arn  = module.kms.logs_key_arn
  bundle_dir        = "${path.root}/../../../wazuh"
}

module "prowler" {
  source             = "../../modules/prowler"
  name               = local.name
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  data_kms_key_arn   = module.kms.data_key_arn
  logs_kms_key_arn   = module.kms.logs_key_arn
  image_digest       = var.prowler_image_digest
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "wazuh_instance_id" {
  value = module.wazuh.instance_id
}

output "wazuh_apply_document" {
  value = module.wazuh.apply_document_name
}

output "prowler_repository_url" {
  value = module.prowler.repository_url
}
