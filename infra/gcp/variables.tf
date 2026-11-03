variable "project_id" {
  description = "ID do projeto da GCP da Verax onde o nó fica e que ele monitora."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região do nó. São Paulo por padrão; outras regiões podem sair mais baratas."
  type        = string
  default     = "southamerica-east1"
}

variable "zone" {
  description = "Zona da VM e do disco de dados (dentro da região)."
  type        = string
  default     = "southamerica-east1-a"
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
  description = "Tamanho da VM. O Wazuh pede 4 vCPU e 16 GB."
  type        = string
  default     = "e2-standard-4"
}

variable "data_disk_gb" {
  description = "Tamanho do disco de dados (Wazuh, banco e backups locais), em GB."
  type        = number
  default     = 100

  validation {
    condition     = var.data_disk_gb >= 50 && var.data_disk_gb <= 2000
    error_message = "O disco de dados precisa ter de 50 a 2000 GB."
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
  default     = 1000
}
