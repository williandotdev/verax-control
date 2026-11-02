# EC2 do Wazuh (T4.2): single-node (manager, indexer e dashboard) em Docker, numa subnet privada, sem IP público
# e sem nenhuma porta de entrada aberta por padrão. Acesso só pelo SSM Session Manager.
#
# - Disco de dados separado, cifrado com KMS e protegido contra destruição: trocar a instância não perde alertas.
# - Senhas geradas aqui e gravadas no Secrets Manager por argumento write-only: não passam pelo state.
# - Configuração vinda do bundle versionado em infra/wazuh, entregue por um bucket privado com checksums.
# - Reaplicar (configuração nova ou rotação de senha): documento SSM `<nome>-wazuh-apply` (README do bundle).

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

variable "subnet_id" {
  description = "Subnet privada onde a instância roda."
  type        = string
}

variable "data_kms_key_arn" {
  description = "Chave KMS de dados (discos, segredo e bundle)."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "Chave KMS dos logs dos contêineres."
  type        = string
}

variable "bundle_dir" {
  description = "Caminho do bundle do Wazuh (infra/wazuh)."
  type        = string
}

variable "instance_type" {
  description = "4 vCPU e 16 GB (critério da T4.2)."
  type        = string
  default     = "m7i.xlarge"
}

variable "indexer_heap" {
  description = "Heap do indexer (cerca de metade do que sobra depois de manager e dashboard)."
  type        = string
  default     = "6g"
  validation {
    condition     = can(regex("^[0-9]+[mg]$", var.indexer_heap))
    error_message = "Use o formato da JVM, como 6g ou 4096m."
  }
}

variable "data_volume_size_gb" {
  description = "Disco dos dados do Wazuh (alertas por 90 dias)."
  type        = number
  default     = 200
}

variable "root_volume_size_gb" {
  description = "Disco do sistema."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  description = "Retenção dos logs dos contêineres no CloudWatch."
  type        = number
  default     = 365
}

variable "indexer_client_security_groups" {
  description = "Security groups liberados no indexer (9200), por nome lógico. Vazio até a T4.8."
  type        = map(string)
  default     = {}
}

variable "termination_protection" {
  description = "Bloqueia o encerramento da instância pela API."
  type        = bool
  default     = true
}

variable "password_version" {
  description = "Aumente para gerar senhas novas (rotação); depois rode o documento SSM de reaplicação."
  type        = number
  default     = 1
}

variable "patch_schedule" {
  description = "Janela semanal de patches do sistema (UTC)."
  type        = string
  default     = "cron(0 6 ? * SUN *)"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_subnet" "this" {
  id = var.subnet_id
}

# AMI mais recente do Amazon Linux 2023 no momento da criação; depois disso o sistema é atualizado pelo Patch
# Manager, e não pela troca da instância (ignore_changes abaixo).
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  region        = data.aws_region.current.region
  bundle_prefix = "wazuh/bundle"
  bundle_files = sort(concat(
    tolist(fileset(var.bundle_dir, "docker-compose.yml")),
    tolist(fileset(var.bundle_dir, "config/**")),
    tolist(fileset(var.bundle_dir, "scripts/**")),
  ))
  sha256sums = join("", [for file in local.bundle_files : "${filesha256("${var.bundle_dir}/${file}")}  ${file}\n"])

  apply_script = templatefile("${path.module}/apply.sh.tftpl", {
    region         = local.region
    bucket         = module.bundle_bucket.id
    prefix         = local.bundle_prefix
    secret_arn     = aws_secretsmanager_secret.wazuh.arn
    data_volume_id = aws_ebs_volume.data.id
    log_group      = aws_cloudwatch_log_group.containers.name
    indexer_heap   = var.indexer_heap
  })
}

# --- Bundle ---

module "bundle_bucket" {
  source      = "../private-bucket"
  name        = "${var.name}-wazuh-${data.aws_caller_identity.current.account_id}"
  kms_key_arn = var.data_kms_key_arn
}

resource "aws_s3_object" "bundle" {
  for_each    = toset(local.bundle_files)
  bucket      = module.bundle_bucket.id
  key         = "${local.bundle_prefix}/${each.value}"
  source      = "${var.bundle_dir}/${each.value}"
  source_hash = filemd5("${var.bundle_dir}/${each.value}")
  kms_key_id  = var.data_kms_key_arn
}

resource "aws_s3_object" "sha256sums" {
  bucket     = module.bundle_bucket.id
  key        = "${local.bundle_prefix}/SHA256SUMS"
  content    = local.sha256sums
  kms_key_id = var.data_kms_key_arn
}

# --- Senhas ---

resource "aws_secretsmanager_secret" "wazuh" {
  #checkov:skip=CKV2_AWS_57:Rotação manual e versionada (password_version + documento SSM de reaplicação). A senha nova precisa chegar aos três contêineres, o que uma Lambda de rotação não faz.
  name                    = "${var.name}/wazuh"
  description             = "Senhas do Wazuh: admin e kibanaserver do indexer, wazuh-wui da API do manager"
  kms_key_id              = var.data_kms_key_arn
  recovery_window_in_days = 30
}

# Geradas pela própria AWS a cada plan/apply, sem ir para o state; só são gravadas quando password_version muda.
# Só letras e dígitos (com ao menos uma maiúscula, uma minúscula e um dígito); o prefixo "Vc-" garante a letra
# inicial e o símbolo que a API do Wazuh exige (formato conferido pelo scripts/deploy.sh do bundle).
ephemeral "aws_secretsmanager_random_password" "indexer_admin" {
  password_length            = 40
  exclude_punctuation        = true
  include_space              = false
  require_each_included_type = true
}

ephemeral "aws_secretsmanager_random_password" "indexer_dashboard" {
  password_length            = 40
  exclude_punctuation        = true
  include_space              = false
  require_each_included_type = true
}

ephemeral "aws_secretsmanager_random_password" "wazuh_api" {
  password_length            = 40
  exclude_punctuation        = true
  include_space              = false
  require_each_included_type = true
}

resource "aws_secretsmanager_secret_version" "wazuh" {
  secret_id = aws_secretsmanager_secret.wazuh.id
  secret_string_wo = jsonencode({
    indexer_admin     = "Vc-${ephemeral.aws_secretsmanager_random_password.indexer_admin.random_password}"
    indexer_dashboard = "Vc-${ephemeral.aws_secretsmanager_random_password.indexer_dashboard.random_password}"
    wazuh_api         = "Vc-${ephemeral.aws_secretsmanager_random_password.wazuh_api.random_password}"
  })
  secret_string_wo_version = var.password_version
}

# --- Rede ---

resource "aws_security_group" "wazuh" {
  name        = "${var.name}-wazuh"
  description = "Wazuh: sem entrada por padrao (acesso por SSM); saida so HTTPS"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-wazuh" }
}

# Exceção à regra AWS-0104 do Trivy (saída para qualquer IP): o Wazuh precisa baixar as imagens do Docker Hub e o
# feed de vulnerabilidades (cti.wazuh.com), ambos com IPs dinâmicos, sem CIDR fixo para liberar. A saída fica
# limitada à porta 443 e passa pelo NAT, com flow logs. Restringir por domínio exigiria o AWS Network Firewall.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.wazuh.id
  description       = "HTTPS: imagens, feed de vulnerabilidades e APIs da AWS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "indexer" {
  for_each                     = var.indexer_client_security_groups
  security_group_id            = aws_security_group.wazuh.id
  description                  = "Indexer (9200) para ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 9200
  to_port                      = 9200
  referenced_security_group_id = each.value
}

# --- Permissões da instância ---

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "wazuh" {
  name               = "${var.name}-wazuh"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.wazuh.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "wazuh" {
  statement {
    sid       = "LerSenhas"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.wazuh.arn]
  }

  statement {
    sid       = "DecifrarSenhasEBundle"
    actions   = ["kms:Decrypt"]
    resources = [var.data_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${local.region}.amazonaws.com", "s3.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "ListarBundle"
    actions   = ["s3:ListBucket"]
    resources = [module.bundle_bucket.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.bundle_prefix}/*"]
    }
  }

  statement {
    sid       = "LerBundle"
    actions   = ["s3:GetObject"]
    resources = ["${module.bundle_bucket.arn}/${local.bundle_prefix}/*"]
  }

  statement {
    sid       = "LogsDosConteineres"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.containers.arn}:*"]
  }
}

resource "aws_iam_role_policy" "wazuh" {
  name   = "wazuh"
  role   = aws_iam_role.wazuh.id
  policy = data.aws_iam_policy_document.wazuh.json
}

resource "aws_iam_instance_profile" "wazuh" {
  name = "${var.name}-wazuh"
  role = aws_iam_role.wazuh.name
}

resource "aws_cloudwatch_log_group" "containers" {
  name              = "/verax-control/${var.name}/wazuh"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

# --- Instância e discos ---

resource "aws_ebs_volume" "data" {
  #checkov:skip=CKV2_AWS_9:O backup do Wazuh é por snapshot do indexer em S3 (T4.9).
  availability_zone = data.aws_subnet.this.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true
  kms_key_id        = var.data_kms_key_arn
  final_snapshot    = true
  tags              = { Name = "${var.name}-wazuh-data" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "wazuh" {
  ami                         = data.aws_ssm_parameter.al2023.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [aws_security_group.wazuh.id]
  iam_instance_profile        = aws_iam_instance_profile.wazuh.name
  associate_public_ip_address = false
  monitoring                  = true
  ebs_optimized               = true
  disable_api_termination     = var.termination_protection
  user_data                   = local.apply_script
  user_data_replace_on_change = false

  # IMDSv2 obrigatório; com hop limit 1, nenhum contêiner alcança as credenciais da instância.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    kms_key_id            = var.data_kms_key_arn
    delete_on_termination = true
    tags                  = { Name = "${var.name}-wazuh-root" }
  }

  tags = { Name = "${var.name}-wazuh" }

  lifecycle {
    # Atualizações de sistema vêm do Patch Manager e as de configuração, do documento SSM de reaplicação.
    ignore_changes = [ami, user_data]
  }

  depends_on = [
    aws_s3_object.bundle,
    aws_s3_object.sha256sums,
    aws_secretsmanager_secret_version.wazuh,
    aws_iam_role_policy.wazuh,
  ]
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.wazuh.id
  stop_instance_before_detaching = true
}

# --- Operação ---

resource "aws_ssm_document" "apply" {
  name            = "${var.name}-wazuh-apply"
  document_type   = "Command"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Reaplica o bundle do Wazuh com as senhas atuais do Secrets Manager."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "aplicar"
      inputs = {
        runCommand     = split("\n", local.apply_script)
        timeoutSeconds = "3600"
      }
    }]
  })
}

resource "aws_ssm_association" "patch" {
  association_name    = "${var.name}-wazuh-patch"
  name                = "AWS-RunPatchBaseline"
  schedule_expression = var.patch_schedule
  compliance_severity = "HIGH"
  parameters = {
    Operation    = "Install"
    RebootOption = "RebootIfNeeded"
  }
  targets {
    key    = "InstanceIds"
    values = [aws_instance.wazuh.id]
  }
}

output "instance_id" {
  value = aws_instance.wazuh.id
}

output "security_group_id" {
  value = aws_security_group.wazuh.id
}

output "secret_arn" {
  value = aws_secretsmanager_secret.wazuh.arn
}

output "apply_document_name" {
  value = aws_ssm_document.apply.name
}
