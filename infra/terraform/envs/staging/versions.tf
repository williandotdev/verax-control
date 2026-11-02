terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.71.0"
    }
  }

  # State remoto no bucket criado pelo bootstrap, com lock nativo do S3 e SSE-KMS. Bucket, chave e região
  # vêm de `backend.hcl` (modelo em backend.hcl.example), passado em `terraform init -backend-config`.
  backend "s3" {
    key          = "verax-control/staging/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
