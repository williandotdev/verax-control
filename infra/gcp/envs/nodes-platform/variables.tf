variable "project_id" {
  description = "ID do projeto da GCP dos nós de clientes (o mesmo da homologação, separado do projeto da Verax e do plano de controle)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região dos nós de clientes e do bucket do estado: São Paulo. Tem de ser a do bucket criado no passo 2 do GUIA.md (a região de um bucket não muda)."
  type        = string
  default     = "southamerica-east1"
}

variable "control_plane_project_id" {
  description = "Projeto do plano de controle (envs/control-plane), onde estão as contas `cp-terraform` e `cp-worker`. Vazio: nenhuma permissão do plano de controle neste projeto (só APIs, bucket do estado e orçamento, o que a homologação precisa). Preenchido: os papéis do executor Terraform e o ciclo de vida das VMs `vx-*` (control_plane.tf). Exige o envs/control-plane aplicado antes (as contas precisam existir)."
  type        = string
  default     = ""

  validation {
    condition     = var.control_plane_project_id == "" || can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.control_plane_project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }

  validation {
    condition     = var.control_plane_project_id != var.project_id
    error_message = "O plano de controle fica em outro projeto (o do Firebase dos painéis), nunca no projeto dos nós."
  }
}

variable "billing_account_id" {
  description = "Conta de faturamento, para o alerta de orçamento do projeto dos nós (formato 000000-000000-000000). Vazio: sem orçamento. Com este preenchido, deixe vazio o da homologação, que vigia o mesmo projeto."
  type        = string
  default     = ""

  validation {
    condition     = var.billing_account_id == "" || can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "Conta de faturamento no formato 000000-000000-000000."
  }
}

variable "monthly_budget" {
  description = "Orçamento mensal do projeto dos nós, na moeda da conta de faturamento. Avisos em 50%, 90% e 100% e na previsão de 100%. Cresce com os clientes: suba o valor a cada cliente novo (o custo de um nó standard está em docs/ARQUITETURA.md, \"Custo por nó\", sem valores)."
  type        = number
  default     = 300

  validation {
    condition     = var.monthly_budget > 0
    error_message = "O orçamento precisa ser maior que zero."
  }
}
