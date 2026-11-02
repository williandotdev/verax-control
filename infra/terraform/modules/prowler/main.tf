# Prowler agendado (T4.7): uma tarefa do ECS Fargate, disparada todo dia pelo EventBridge Scheduler, roda o
# Prowler em cada conta conectada (papel VeraxControlReadOnly com ExternalId) e grava o JSON-OCSF num bucket privado
# da Verax, em <tenantId>/<conta>/<data>/. Imagem e entrypoint em infra/prowler.
#
# A imagem é publicada no ECR pelo pipeline de deploy (E8), que informa o digest em `image_digest`. Sem digest, só a
# base existe (repositório, bucket, segredo, papéis); tarefa e agendamento nascem quando a imagem estiver publicada.

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
  description = "VPC do ambiente."
  type        = string
}

variable "private_subnet_ids" {
  description = "Subnets privadas onde a tarefa roda."
  type        = list(string)
}

variable "data_kms_key_arn" {
  description = "Chave KMS de dados (repositório, bucket e segredo)."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "Chave KMS dos logs da tarefa."
  type        = string
}

variable "image_digest" {
  description = "Digest da imagem publicada no ECR (sha256:...), informado pelo deploy. Nulo: sem tarefa nem agendamento."
  type        = string
  default     = null
  validation {
    condition     = var.image_digest == null || can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "Use o digest completo, no formato sha256:<64 hex>."
  }
}

variable "schedule_expression" {
  description = "Quando a análise roda (fuso em schedule_timezone)."
  type        = string
  default     = "cron(0 3 * * ? *)"
}

variable "schedule_timezone" {
  description = "Fuso do agendamento."
  type        = string
  default     = "America/Sao_Paulo"
}

variable "results_retention_days" {
  description = "Dias de retenção dos relatórios brutos (a nota e o histórico ficam no banco da API)."
  type        = number
  default     = 90
}

variable "log_retention_days" {
  description = "Retenção dos logs da tarefa."
  type        = number
  default     = 365
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  region    = data.aws_region.current.region
  partition = data.aws_partition.current.partition
  account   = data.aws_caller_identity.current.account_id
  enabled   = var.image_digest != null
}

# --- Imagem ---

resource "aws_ecr_repository" "prowler" {
  name                 = "${var.name}-prowler"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.data_kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "prowler" {
  repository = aws_ecr_repository.prowler.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Mantém as 10 imagens mais recentes"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

# --- Resultados e lista de contas ---

module "results_bucket" {
  source          = "../private-bucket"
  name            = "${var.name}-prowler-${local.account}"
  kms_key_arn     = var.data_kms_key_arn
  expiration_days = var.results_retention_days
}

# Lista de contas (tenantId, conta, ExternalId e, opcionalmente, regiões), mantida pela API a partir do cadastro.
# O Terraform só grava a lista vazia na criação (write-only, versão fixa): nunca sobrescreve o que a API gravar.
resource "aws_secretsmanager_secret" "targets" {
  #checkov:skip=CKV2_AWS_57:Não é credencial: é a lista de contas. Os ExternalIds são trocados pela API, conta a conta.
  name                    = "${var.name}/prowler-targets"
  description             = "Contas AWS analisadas pelo Prowler (com os ExternalIds); mantida pela API"
  kms_key_id              = var.data_kms_key_arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "targets" {
  secret_id                = aws_secretsmanager_secret.targets.id
  secret_string_wo         = "[]"
  secret_string_wo_version = 1
}

resource "aws_cloudwatch_log_group" "prowler" {
  name              = "/verax-control/${var.name}/prowler"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

# --- Rede ---

resource "aws_security_group" "prowler" {
  #checkov:skip=CKV2_AWS_5:Ligado à tarefa pela configuração de rede do agendamento (ecs_parameters), que o checkov não acompanha.
  name        = "${var.name}-prowler"
  description = "Prowler: sem entrada; saida so HTTPS para as APIs da AWS"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-prowler" }
}

# Exceção à regra AWS-0104 do Trivy (saída para qualquer IP): o Prowler consulta as APIs públicas da AWS em todas as
# regiões das contas dos clientes, sem CIDR fixo para liberar. Saída só na porta 443, pelo NAT, com flow logs.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.prowler.id
  description       = "HTTPS para as APIs da AWS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
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

# Execução: só baixar a imagem e escrever o log.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-prowler-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Tarefa: o nome bate com o prefixo que o conector do cliente aceita (verax-control-production-*).
resource "aws_iam_role" "task" {
  name               = "${var.name}-prowler"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "AssumirPapelDosClientes"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:${local.partition}:iam::*:role/VeraxControlReadOnly"]
  }

  statement {
    sid       = "LerListaDeContas"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.targets.arn]
  }

  statement {
    sid       = "GravarResultados"
    actions   = ["s3:PutObject"]
    resources = ["${module.results_bucket.arn}/*"]
  }

  statement {
    sid       = "ChaveDosResultadosEDaLista"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${local.region}.amazonaws.com", "s3.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "prowler"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# --- Tarefa e agendamento ---

resource "aws_ecs_cluster" "prowler" {
  name = "${var.name}-prowler"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "prowler" {
  count                    = local.enabled ? 1 : 0
  family                   = "${var.name}-prowler"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = "prowler"
    image                  = "${aws_ecr_repository.prowler.repository_url}@${var.image_digest}"
    essential              = true
    user                   = "1000"
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    linuxParameters        = { initProcessEnabled = true }
    environment = [
      { name = "PROWLER_TARGETS_SECRET_ARN", value = aws_secretsmanager_secret.targets.arn },
      { name = "RESULTS_BUCKET", value = module.results_bucket.id },
      { name = "AWS_REGION", value = local.region },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.prowler.name
        awslogs-region        = local.region
        awslogs-stream-prefix = "prowler"
      }
    }
  }])
}

data "aws_iam_policy_document" "assume_scheduler" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  count              = local.enabled ? 1 : 0
  name               = "${var.name}-prowler-scheduler"
  assume_role_policy = data.aws_iam_policy_document.assume_scheduler.json
}

data "aws_iam_policy_document" "scheduler" {
  count = local.enabled ? 1 : 0

  statement {
    sid       = "RodarSoEstaTarefa"
    actions   = ["ecs:RunTask"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:task-definition/${var.name}-prowler:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.prowler.arn]
    }
  }

  # O agendamento é cifrado com a chave de dados; o agendador precisa dela para ler o próprio alvo.
  statement {
    sid       = "DecifrarAgendamento"
    actions   = ["kms:Decrypt"]
    resources = [var.data_kms_key_arn]
  }

  statement {
    sid       = "PassarSoOsPapeisDaTarefa"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "scheduler" {
  count  = local.enabled ? 1 : 0
  name   = "rodar-prowler"
  role   = aws_iam_role.scheduler[0].id
  policy = data.aws_iam_policy_document.scheduler[0].json
}

resource "aws_scheduler_schedule" "prowler" {
  count                        = local.enabled ? 1 : 0
  name                         = "${var.name}-prowler"
  description                  = "Análise diária de configuração das contas conectadas (Prowler)"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = var.schedule_timezone
  kms_key_arn                  = var.data_kms_key_arn

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.prowler.arn
    role_arn = aws_iam_role.scheduler[0].arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.prowler[0].arn
      launch_type         = "FARGATE"
      platform_version    = "LATEST"
      task_count          = 1

      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [aws_security_group.prowler.id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts       = 1
      maximum_event_age_in_seconds = 3600
    }
  }
}

output "repository_url" {
  value = aws_ecr_repository.prowler.repository_url
}

output "results_bucket" {
  value = module.results_bucket.id
}

output "targets_secret_arn" {
  description = "Segredo da lista de contas que a API atualiza."
  value       = aws_secretsmanager_secret.targets.arn
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "cluster_arn" {
  value = aws_ecs_cluster.prowler.arn
}
