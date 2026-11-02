# Papel do deploy de um ambiente (T8.5), assumido pelo GitHub Actions por OIDC, sem chave fixa. Só o environment do
# GitHub com o mesmo nome assume (produção exige aprovação manual no GitHub).
#
# Permissão mínima para publicar uma versão da aplicação: enviar as imagens ao ECR, registrar revisões das tarefas
# (trocando só a imagem), rodar o bootstrap e as migrations, atualizar o serviço e publicar o painel. Não cria nem
# altera IAM, rede, banco ou segredos: mudanças de infraestrutura são aplicadas no Terraform por quem administra a
# conta (README de infra/terraform).

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
  description = "Prefixo dos recursos do ambiente (ex.: verax-control-production)."
  type        = string
}

variable "environment" {
  description = "Nome do environment do GitHub (staging ou production)."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Use staging ou production."
  }
}

variable "github_repository" {
  description = "Repositório que pode fazer o deploy (dono/nome)."
  type        = string
  default     = "williandotdev/verax-control"
}

variable "cluster_arn" {
  type = string
}

variable "repository_arns" {
  description = "Repositórios ECR da API e das migrations."
  type        = list(string)
}

variable "pass_role_arns" {
  description = "Papéis de execução e de tarefa que as revisões novas usam."
  type        = list(string)
}

variable "job_log_group_arns" {
  description = "Logs do bootstrap e das migrations (o deploy mostra a saída quando falham)."
  type        = list(string)
}

variable "panel_bucket_arn" {
  type = string
}

variable "panel_kms_key_arn" {
  type = string
}

variable "distribution_arn" {
  type = string
}

variable "release_config" {
  description = "O que o deploy precisa saber do ambiente (cluster, repositórios, rede das tarefas, painel, domínios)."
  type        = map(string)
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  region       = data.aws_region.current.region
  account      = data.aws_caller_identity.current.account_id
  partition    = data.aws_partition.current.partition
  cluster_name = element(split("/", var.cluster_arn), 1)
  oidc_host    = "token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Só jobs do environment deste ambiente, neste repositório.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${var.github_repository}:environment:${var.environment}"]
    }
  }
}

# Configuração lida pelo deploy (não é segredo) e registro das imagens que ele publicou: o Terraform lê esse
# registro para não voltar a uma imagem antiga ao reaplicar (README de infra/terraform).
resource "aws_ssm_parameter" "release_config" {
  #checkov:skip=CKV2_AWS_34:Nomes e endereços do ambiente, não são segredo.
  name        = "/verax-control/${var.name}/release/config"
  description = "Configuração do deploy de ${var.environment}"
  type        = "String"
  value       = jsonencode(var.release_config)
}

resource "aws_ssm_parameter" "release_images" {
  #checkov:skip=CKV2_AWS_34:Digests de imagem, não são segredo.
  name        = "/verax-control/${var.name}/release/images"
  description = "Imagens publicadas pelo último deploy de ${var.environment}"
  type        = "String"
  value       = jsonencode({ api = "", migrate = "" })
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-deploy"
  description          = "Deploy da aplicação pelo GitHub Actions (${var.environment})"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "LoginNoEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EnviarImagens"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages",
    ]
    resources = var.repository_arns
  }

  # RegisterTaskDefinition e DescribeTaskDefinition não aceitam recurso específico na AWS. O que a revisão pode
  # fazer é limitado pelos papéis que ela pode receber (PassRole abaixo).
  statement {
    sid       = "RevisoesDasTarefas"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid     = "RodarBootstrapEMigrations"
    actions = ["ecs:RunTask"]
    resources = [
      "arn:${local.partition}:ecs:${local.region}:${local.account}:task-definition/${var.name}-db-bootstrap:*",
      "arn:${local.partition}:ecs:${local.region}:${local.account}:task-definition/${var.name}-migrate:*",
    ]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "AcompanharTarefas"
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:task/${local.cluster_name}/*"]
  }

  statement {
    sid       = "AtualizarServicoDaApi"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:service/${local.cluster_name}/api"]
  }

  statement {
    sid       = "PassarSoOsPapeisDasTarefas"
    actions   = ["iam:PassRole"]
    resources = var.pass_role_arns
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "LerSaidaDasTarefas"
    actions   = ["logs:GetLogEvents", "logs:DescribeLogStreams"]
    resources = flatten([for arn in var.job_log_group_arns : [arn, "${arn}:*"]])
  }

  statement {
    sid       = "ConfiguracaoDoDeploy"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.release_config.arn, aws_ssm_parameter.release_images.arn]
  }

  statement {
    sid       = "RegistrarImagensPublicadas"
    actions   = ["ssm:PutParameter"]
    resources = [aws_ssm_parameter.release_images.arn]
  }

  statement {
    sid       = "ListarPainel"
    actions   = ["s3:ListBucket"]
    resources = [var.panel_bucket_arn]
  }

  statement {
    sid       = "PublicarPainel"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.panel_bucket_arn}/*"]
  }

  statement {
    sid       = "ChaveDoPainel"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.panel_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "InvalidarCachePainel"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [var.distribution_arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "role_arn" {
  description = "Valor da variável AWS_DEPLOY_ROLE_ARN do environment no GitHub."
  value       = aws_iam_role.deploy.arn
}
