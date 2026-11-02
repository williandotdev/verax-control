# Banco da aplicação (T8.1): RDS PostgreSQL 18 em subnets privadas, sem acesso público, cifrado com a chave de dados,
# TLS obrigatório, backups automáticos e senha mestra gerenciada pelo próprio RDS no Secrets Manager (não passa pelo
# state nem pelo código). A aplicação não usa a conta mestra: os papéis de banco dela nascem no bootstrap (T8.2).

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
  description = "Subnets privadas (duas zonas)."
  type        = list(string)
}

variable "data_kms_key_arn" {
  description = "Chave KMS de dados (disco, Performance Insights e senha mestra)."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "Chave KMS dos logs exportados."
  type        = string
}

variable "instance_class" {
  description = "Classe da instância."
  type        = string
  default     = "db.t4g.medium"
}

variable "allocated_storage_gb" {
  description = "Disco inicial (cresce sozinho até max_allocated_storage_gb)."
  type        = number
  default     = 20
}

variable "max_allocated_storage_gb" {
  description = "Teto do crescimento automático do disco."
  type        = number
  default     = 200
}

variable "multi_az" {
  description = "Réplica síncrona em outra zona (produção)."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Dias de backup automático (com restauração para qualquer ponto no tempo)."
  type        = number
  default     = 14
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "Use de 7 a 35 dias."
  }
}

variable "deletion_protection" {
  description = "Impede apagar o banco pela API."
  type        = bool
  default     = true
}

variable "client_security_groups" {
  description = "Security groups que podem abrir conexão (API, worker, migrations), por nome lógico."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  description = "Retenção dos logs exportados."
  type        = number
  default     = 365
}

data "aws_partition" "current" {}

locals {
  identifier = "${var.name}-db"
}

resource "aws_db_subnet_group" "this" {
  name       = local.identifier
  subnet_ids = var.private_subnet_ids
}

# Sem regra de saída: o banco só responde. Entrada só dos security groups autorizados.
resource "aws_security_group" "db" {
  name        = local.identifier
  description = "PostgreSQL: entrada so da API e dos jobs; sem saida"
  vpc_id      = var.vpc_id
  tags        = { Name = local.identifier }
}

resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each                     = var.client_security_groups
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL para ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

resource "aws_db_parameter_group" "this" {
  name        = local.identifier
  family      = "postgres18"
  description = "Verax Control: TLS obrigatório e log de conexões"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.2"
  }

  parameter {
    name  = "password_encryption"
    value = "scram-sha-256"
  }

  # No PostgreSQL 18 o parâmetro virou lista, e o RDS recusa o antigo "1" na família postgres18. Segundo as notas do
  # RDS, "1" equivale a estas três fases: chegada, autenticação e autorização da conexão.
  parameter {
    name  = "log_connections"
    value = "receipt,authentication,authorization"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  # Sem log de consultas: ele grava os valores dos parâmetros (que podem ser dados pessoais ou tokens). Consultas
  # lentas ficam no Performance Insights, que mostra a consulta normalizada, sem valores.
}

# Criados antes do banco para nascerem com KMS e retenção (o RDS criaria sem as duas coisas).
resource "aws_cloudwatch_log_group" "exports" {
  for_each          = toset(["postgresql", "upgrade"])
  name              = "/aws/rds/instance/${local.identifier}/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  name               = "${local.identifier}-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_157:Multi-AZ é variável: ligado em produção (explícito em envs/production) e desligado no staging, que só tem dados fictícios (pendência 7).
  #checkov:skip=CKV_AWS_293:Proteção contra exclusão é variável: ligada em produção (explícito em envs/production) e desligada no staging, que pode ser recriado.
  identifier     = local.identifier
  engine         = "postgres"
  engine_version = "18"
  instance_class = var.instance_class
  db_name        = "verax"
  port           = 5432

  # Senha mestra gerada e guardada pelo RDS no Secrets Manager, cifrada com a chave de dados.
  username                      = "verax_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.data_kms_key_arn

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.data_kms_key_arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = var.multi_az
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  iam_database_authentication_enabled = true
  auto_minor_version_upgrade          = true
  allow_major_version_upgrade         = false
  maintenance_window                  = "sun:07:00-sun:08:00"

  backup_retention_period   = var.backup_retention_days
  backup_window             = "05:00-06:00"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.identifier}-final"

  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.monitoring.arn
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.data_kms_key_arn
  performance_insights_retention_period = 7

  depends_on = [aws_cloudwatch_log_group.exports]
}

output "endpoint" {
  description = "Endereço do banco (só resolve e responde dentro da VPC)."
  value       = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "master_secret_arn" {
  description = "Segredo da senha mestra, gerenciado pelo RDS. Usado só pelo bootstrap dos papéis de banco (T8.2)."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "resource_id" {
  value = aws_db_instance.this.resource_id
}

output "identifier" {
  value = aws_db_instance.this.identifier
}
