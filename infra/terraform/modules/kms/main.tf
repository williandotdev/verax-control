# Chaves KMS do ambiente (T4.1): uma para dados (buckets, discos, segredos) e uma para logs. Rotação anual
# automática; a política da chave de logs libera o CloudWatch Logs da própria conta e região.

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
  description = "Prefixo dos aliases (ex.: verax-control-staging)."
  type        = string
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_root = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
}

data "aws_iam_policy_document" "data" {
  #checkov:skip=CKV_AWS_356:Política de chave KMS: "*" é a própria chave; padrão da AWS para delegar ao IAM da conta.
  #checkov:skip=CKV_AWS_111:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  #checkov:skip=CKV_AWS_109:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }
}

data "aws_iam_policy_document" "logs" {
  #checkov:skip=CKV_AWS_356:Política de chave KMS: "*" é a própria chave; padrão da AWS para delegar ao IAM da conta.
  #checkov:skip=CKV_AWS_111:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  #checkov:skip=CKV_AWS_109:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  statement {
    sid = "CloudWatchLogsDaConta"
    actions = [
      "kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "${var.name}: dados (buckets, discos e segredos)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.data.json
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "logs" {
  description             = "${var.name}: logs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.logs.json
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

output "data_key_arn" {
  value = aws_kms_key.data.arn
}

output "logs_key_arn" {
  value = aws_kms_key.logs.arn
}
