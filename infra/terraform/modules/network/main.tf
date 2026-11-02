# Rede da conta Verax (T4.1): VPC em 2 zonas, subnets públicas (só NAT e, no E8, o ALB) e privadas (Wazuh,
# API, worker, Prowler), flow logs cifrados, security group padrão sem regras e endpoints privados para os
# serviços AWS usados, para esse tráfego não passar pela internet.

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
  description = "Prefixo dos recursos (ex.: verax-control-staging)."
  type        = string
}

variable "cidr_block" {
  description = "Faixa da VPC."
  type        = string
}

variable "availability_zones" {
  description = "Exatamente duas zonas de disponibilidade."
  type        = list(string)
  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "Informe exatamente duas zonas de disponibilidade."
  }
}

variable "nat_gateways" {
  description = "1 (staging, economia) ou 2 (produção, uma por zona)."
  type        = number
  default     = 1
  validation {
    condition     = contains([1, 2], var.nat_gateways)
    error_message = "Use 1 ou 2 NAT gateways."
  }
}

variable "logs_kms_key_arn" {
  description = "Chave KMS dos logs (flow logs)."
  type        = string
}

variable "log_retention_days" {
  description = "Retenção dos flow logs."
  type        = number
  default     = 365
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  public_cidrs  = [for index in range(2) : cidrsubnet(var.cidr_block, 8, index)]
  private_cidrs = [for index in range(2) : cidrsubnet(var.cidr_block, 4, index + 1)]
  interface_endpoints = [
    "ssm", "ssmmessages", "ec2messages", "secretsmanager", "logs", "sts", "ecr.api", "ecr.dkr", "kms",
  ]
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

# Security group padrão sem nenhuma regra: nada usa o padrão por engano.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-default-sem-regras" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-publica-${count.index + 1}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  tags              = { Name = "${var.name}-privada-${count.index + 1}", Tier = "private" }
}

resource "aws_eip" "nat" {
  count  = var.nat_gateways
  domain = "vpc"
  tags   = { Name = "${var.name}-nat-${count.index + 1}" }
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_gateways
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${var.name}-nat-${count.index + 1}" }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-publica" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[min(count.index, var.nat_gateways - 1)].id
  }
  tags = { Name = "${var.name}-privada-${count.index + 1}" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# --- Flow logs ---

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/verax-control/${var.name}/vpc-flow-logs"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

# Só flow logs desta conta e região assumem o papel (proteção contra "confused deputy" recomendada pela AWS).
data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:vpc-flow-log/*"]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${var.name}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume.json
}

data "aws_iam_policy_document" "flow_logs_write" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow_logs.arn}:*"]
  }
  # Permissão mínima exigida pela AWS para publicar flow logs; a ação não aceita restrição por recurso.
  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  name   = "escrever-flow-logs"
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs_write.json
}

resource "aws_flow_log" "this" {
  vpc_id          = aws_vpc.this.id
  traffic_type    = "ALL"
  log_destination = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn    = aws_iam_role.flow_logs.arn
}

# --- Endpoints privados ---

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "HTTPS da propria VPC para os endpoints de servicos AWS"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS a partir da VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr_block]
  }

  egress {
    description = "Respostas dentro da VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.cidr_block]
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(local.interface_endpoints)
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-${each.value}" }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
  tags              = { Name = "${var.name}-s3" }
}

# --- DNS privado ---

# Nomes internos do ambiente (ex.: o indexer do Wazuh), resolvidos só dentro da VPC. O certificado do indexer é
# emitido para esse nome, e a API valida o TLS por ele.
resource "aws_route53_zone" "private" {
  #checkov:skip=CKV2_AWS_38:DNSSEC só se aplica a zonas públicas; esta é privada, resolvida só na VPC.
  #checkov:skip=CKV2_AWS_39:Zona privada: o log de consultas é o do Resolver da VPC, que entra com a observabilidade (T8.6).
  name    = "${var.name}.internal"
  comment = "Nomes internos de ${var.name}"
  vpc {
    vpc_id = aws_vpc.this.id
  }
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_zone_id" {
  value = aws_route53_zone.private.zone_id
}

output "private_zone_name" {
  value = aws_route53_zone.private.name
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}
