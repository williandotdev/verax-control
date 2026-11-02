# Monitoramento e alarmes (T8.6). Os logs já ficam no CloudWatch, cifrados e com retenção (cada módulo cria os seus),
# e a aplicação remove segredos antes de registrar (redaction do logger, T1.1). Aqui ficam os alarmes e o aviso:
# - API: respostas 5xx, alvos fora do ar e tarefas abaixo do desejado;
# - banco: CPU e espaço livre;
# - Wazuh: disco de dados acima do limite (métrica do agente do CloudWatch na instância);
# - tarefas do Prowler e do deploy que terminam com erro (evento do ECS);
# - sincronização de alertas parada e conta sem evento há horas: métricas que o worker do E5 publica (contrato abaixo);
#   os alarmes ficam desligados até o worker existir (`sync_alarms_enabled`).
# Todos avisam por um tópico SNS cifrado.

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
  type = string
}

variable "alarm_email" {
  description = "E-mail que recebe os alarmes (confirmação pelo próprio e-mail). Nulo: sem assinatura por e-mail."
  type        = string
  default     = null
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffix" {
  type = string
}

variable "api_cluster_name" {
  type = string
}

variable "api_service_name" {
  type    = string
  default = "api"
}

variable "api_desired_count" {
  type = number
}

variable "database_identifier" {
  type = string
}

variable "wazuh_instance_id" {
  description = "Instância do Wazuh (nula onde não há Wazuh, como no staging)."
  type        = string
  default     = null
}

variable "watched_cluster_arns" {
  description = "Clusters cujas tarefas avulsas avisam quando terminam com erro (Prowler e tarefas do deploy)."
  type        = list(string)
}

variable "sync_alarms_enabled" {
  description = "Liga os alarmes do worker de sincronização (E5), quando ele estiver publicando as métricas."
  type        = bool
  default     = false
}

variable "account_silence_hours" {
  description = "Horas sem nenhum evento que fazem uma conta contar como silenciosa."
  type        = number
  default     = 6
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  actions   = [aws_sns_topic.alarms.arn]
}

# --- Aviso ---

data "aws_iam_policy_document" "alarms_key" {
  #checkov:skip=CKV_AWS_356:Política de chave KMS: "*" é a própria chave; padrão da AWS para delegar ao IAM da conta.
  #checkov:skip=CKV_AWS_111:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  #checkov:skip=CKV_AWS_109:Política de chave KMS restrita ao root da própria conta (padrão da AWS).
  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }

  # CloudWatch e EventBridge publicam no tópico cifrado.
  statement {
    sid       = "PublicadoresDosAlarmes"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_kms_key" "alarms" {
  description             = "${var.name}: tópico de alarmes"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.alarms_key.json
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarmes"
  kms_master_key_id = aws_kms_key.alarms.arn
}

data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid       = "AlarmesDaConta"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# --- API ---

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "A API respondeu com erro 5xx (aplicação ou load balancer) em 2 de 3 janelas de 5 minutos."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "O load balancer da API gerou 5xx (sem alvo saudável ou erro de conexão)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "api_unhealthy" {
  alarm_name          = "${var.name}-api-alvos-fora"
  alarm_description   = "Há tarefas da API reprovando no health check do load balancer."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "api_tasks" {
  alarm_name          = "${var.name}-api-tarefas"
  alarm_description   = "Menos tarefas da API em execução do que o desejado."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.api_cluster_name, ServiceName = var.api_service_name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = var.api_desired_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# --- Banco ---

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-banco-cpu"
  alarm_description   = "CPU do banco acima de 80% por 15 minutos."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.database_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${var.name}-banco-espaco"
  alarm_description   = "Menos de 5 GB livres no banco (o crescimento automático tem teto)."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.database_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 5 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# --- Wazuh ---

# Métrica do agente do CloudWatch instalado pelo bootstrap do Wazuh (infra/wazuh/scripts/bootstrap-host.sh).
resource "aws_cloudwatch_metric_alarm" "wazuh_disk" {
  count               = var.wazuh_instance_id == null ? 0 : 1
  alarm_name          = "${var.name}-wazuh-disco"
  alarm_description   = "Disco de dados do Wazuh acima de 80% (o indexer fica só leitura a 95%)."
  namespace           = "VeraxControl/Wazuh"
  metric_name         = "disk_used_percent"
  dimensions          = { InstanceId = var.wazuh_instance_id, path = "/data", fstype = "xfs" }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "wazuh_status" {
  count               = var.wazuh_instance_id == null ? 0 : 1
  alarm_name          = "${var.name}-wazuh-instancia"
  alarm_description   = "A instância do Wazuh falhou na verificação de status."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = var.wazuh_instance_id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# --- Tarefas avulsas com erro (Prowler e deploy) ---

resource "aws_cloudwatch_event_rule" "failed_tasks" {
  name        = "${var.name}-tarefas-com-erro"
  description = "Tarefas avulsas (Prowler, bootstrap e migrations) que terminam com código diferente de zero"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = var.watched_cluster_arns
      lastStatus = ["STOPPED"]
      group      = [{ prefix = "family:" }]
      containers = { exitCode = [{ anything-but = 0 }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "failed_tasks" {
  rule = aws_cloudwatch_event_rule.failed_tasks.name
  arn  = aws_sns_topic.alarms.arn
  input_transformer {
    input_paths = {
      grupo   = "$.detail.group"
      motivo  = "$.detail.stoppedReason"
      cluster = "$.detail.clusterArn"
    }
    input_template = "\"Tarefa <grupo> terminou com erro no cluster <cluster>: <motivo>\""
  }
}

# --- Sincronização de alertas (contrato com o worker do E5) ---
#
# O worker publica, por métrica embutida no log (EMF), no namespace VeraxControl/Sync:
# - SyncRuns (Count): 1 a cada ciclo de sincronização concluído;
# - SilentAccounts (Count): quantas contas conectadas estão sem nenhum evento há `account_silence_hours` horas.

resource "aws_cloudwatch_metric_alarm" "sync_stalled" {
  count               = var.sync_alarms_enabled ? 1 : 0
  alarm_name          = "${var.name}-sync-parado"
  alarm_description   = "Nenhum ciclo de sincronização de alertas concluído em 30 minutos."
  namespace           = "VeraxControl/Sync"
  metric_name         = "SyncRuns"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "silent_accounts" {
  count               = var.sync_alarms_enabled ? 1 : 0
  alarm_name          = "${var.name}-conta-sem-evento"
  alarm_description   = "Há conta conectada sem nenhum evento há ${var.account_silence_hours} horas (logs parados ou acesso perdido)."
  namespace           = "VeraxControl/Sync"
  metric_name         = "SilentAccounts"
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
