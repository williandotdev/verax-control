# Bootstrap da conta Verax (T4.1): o bucket do state remoto do Terraform e a chave KMS que o cifra.
#
# Roda uma única vez, com state local, por quem administra a conta (procedimento no README). Depois disso,
# todo o resto (envs/staging e envs/production) usa este bucket como backend, com lock nativo do S3
# (`use_lockfile`), versionamento e SSE-KMS. Nada é criado pelo console.

terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.71.0"
    }
  }
}

variable "aws_region" {
  description = "Região da conta Verax."
  type        = string
  default     = "sa-east-1"
}

variable "state_bucket_name" {
  description = "Nome do bucket do state (globalmente único, ex.: verax-control-tfstate-<sufixo>)."
  type        = string
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project   = "verax-control"
      ManagedBy = "terraform"
      Component = "bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "state_key" {
  #checkov:skip=CKV_AWS_356:Política de chave KMS: "*" é a própria chave; padrão da AWS para delegar ao IAM da conta.
  #checkov:skip=CKV_AWS_111:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  #checkov:skip=CKV_AWS_109:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "state" {
  description             = "Verax Control: state do Terraform"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.state_key.json
}

resource "aws_kms_alias" "state" {
  name          = "alias/verax-control-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

module "state_bucket" {
  source                     = "../modules/private-bucket"
  name                       = var.state_bucket_name
  kms_key_arn                = aws_kms_key.state.arn
  noncurrent_expiration_days = 365
}

output "state_bucket" {
  value = module.state_bucket.id
}

output "state_kms_key_arn" {
  value = aws_kms_key.state.arn
}
