variable "project_id" {
  description = "ID do projeto da GCP da Verax onde o nó fica e que ele monitora."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região do nó. us-east1 tem a e2-micro e o disco do nível gratuito da GCP."
  type        = string
  default     = "us-east1"
}

variable "zone" {
  description = "Zona da VM (dentro da região)."
  type        = string
  default     = "us-east1-b"
}

variable "name_prefix" {
  description = "Prefixo de todos os recursos criados. Nada fora deste prefixo é tocado."
  type        = string
  default     = "verax-node"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{3,18}$", var.name_prefix))
    error_message = "Use de 4 a 19 caracteres: minúsculas, números e hífen, começando com letra."
  }
}

variable "machine_type" {
  description = "Tamanho da VM. A e2-micro (1 GB) é gratuita em us-east1, us-central1 e us-west1, uma por conta de faturamento."
  type        = string
  default     = "e2-micro"
}

variable "disk_gb" {
  description = "Disco da VM (sistema, banco e dados do nó), em GB. Até 30 GB de disco padrão entram no nível gratuito."
  type        = number
  default     = 30

  validation {
    condition     = var.disk_gb >= 20 && var.disk_gb <= 500
    error_message = "O disco precisa ter de 20 a 500 GB."
  }
}

variable "monitored_projects" {
  description = "Projetos cujos logs de segurança vão para o nó. Em cada um, um coletor (sink) só copia; nada existente muda."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for project in var.monitored_projects : can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", project))])
    error_message = "Cada item precisa ser um ID de projeto da GCP."
  }
}

variable "subnet_cidr" {
  description = "Faixa de IPs da rede própria do nó. Não pode coincidir com outra rede do projeto."
  type        = string
  default     = "10.80.0.0/24"
}

variable "operators" {
  description = "Quem pode entrar na VM por SSH (pelo IAP, sem porta aberta). Ex.: [\"user:voce@exemplo.com\"]. Dono do projeto já pode."
  type        = list(string)
  default     = []
}

variable "billing_account_id" {
  description = "Conta de faturamento, para o alerta de orçamento (formato 000000-000000-000000). Vazio: sem orçamento."
  type        = string
  default     = ""

  validation {
    condition     = var.billing_account_id == "" || can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "Conta de faturamento no formato 000000-000000-000000."
  }
}

variable "monthly_budget" {
  description = "Orçamento mensal do projeto, na moeda da conta de faturamento. Avisos em 50%, 90% e 100%."
  type        = number
  default     = 50
}
