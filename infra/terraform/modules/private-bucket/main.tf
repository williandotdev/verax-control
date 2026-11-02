# Bucket S3 privado padrão do Verax Control: sem acesso público, dono único dos objetos, criptografia com
# KMS, versionamento, só TLS e ciclo de vida. Todo bucket da conta Verax nasce deste módulo.

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
  description = "Nome do bucket (globalmente único)."
  type        = string
}

variable "kms_key_arn" {
  description = "Chave KMS que cifra os objetos."
  type        = string
}

variable "expiration_days" {
  description = "Dias até apagar a versão atual dos objetos (0 = nunca)."
  type        = number
  default     = 0
}

variable "noncurrent_expiration_days" {
  description = "Dias até apagar versões antigas."
  type        = number
  default     = 30
}

variable "access_log_bucket" {
  description = "Bucket que recebe o log de acesso deste (vazio = sem log; use só no próprio bucket de logs)."
  type        = string
  default     = ""
}

variable "force_destroy" {
  description = "Permite apagar o bucket com objetos (só em ambiente descartável)."
  type        = bool
  default     = false
}

resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_144:Replicação entre regiões fora do MVP (dados reprocessáveis a partir das contas dos clientes).
  #checkov:skip=CKV2_AWS_62:Sem consumidores de eventos de bucket no MVP.
  bucket        = var.name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "retencao"
    status = "Enabled"
    filter {}

    dynamic "expiration" {
      for_each = var.expiration_days > 0 ? [var.expiration_days] : []
      content {
        days = expiration.value
      }
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_logging" "this" {
  count         = var.access_log_bucket == "" ? 0 : 1
  bucket        = aws_s3_bucket.this.id
  target_bucket = var.access_log_bucket
  target_prefix = "${var.name}/"
}

data "aws_iam_policy_document" "tls_only" {
  statement {
    sid     = "SomenteTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]
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

  statement {
    sid     = "TLSMinimo12"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket     = aws_s3_bucket.this.id
  policy     = data.aws_iam_policy_document.tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.this]
}

output "id" {
  value = aws_s3_bucket.this.id
}

output "arn" {
  value = aws_s3_bucket.this.arn
}
