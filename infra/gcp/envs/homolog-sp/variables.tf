variable "project_id" {
  description = "ID do projeto da GCP dos nós de clientes (separado do projeto do nó da Verax)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região do nó de homologação: São Paulo, a mesma dos nós de clientes."
  type        = string
  default     = "southamerica-east1"
}

variable "zone" {
  description = "Zona da VM (dentro da região)."
  type        = string
  default     = "southamerica-east1-b"
}

variable "name_prefix" {
  description = "Prefixo de todos os recursos criados. Nada fora deste prefixo é tocado. Também é o nome da conta de serviço da VM, que pede de 6 a 30 caracteres."
  type        = string
  default     = "verax-homolog"
}

variable "machine_type" {
  description = "Tamanho da VM: e2-standard-2 (padrão do perfil standard) ou e2-standard-4 (plano B, se o ensaio mostrar que 2 vCPU não bastam)."
  type        = string
  default     = "e2-standard-2"
}

variable "disk_gb" {
  description = "Disco da VM (sistema, banco e dados do nó, o indexer do Wazuh inclusive), em GB. Nulo: 60, o do perfil standard. O disco só cresce (veja \"Aumentar o disco\" no GUIA.md)."
  type        = number
  default     = null
}

variable "subnet_cidr" {
  description = "Faixa de IPs da rede própria do nó. Não pode coincidir com outra rede do projeto."
  type        = string
  default     = "10.81.0.0/24"
}

variable "monitored_projects" {
  description = "Projetos de teste cujos logs de segurança vão para o nó (o sink é criado em cada um; você precisa ser dono deles). Projeto de cliente vai em customer_projects."
  type        = list(string)
  default     = []
}

variable "customer_projects" {
  description = "Projetos de clientes (de teste, na homologação: um projeto de outra organização) em que o próprio cliente criou o sink com o comando de Contas cloud: o ID do projeto e a identidade do sink que ele colou no painel. O nó ganha tópico e assinatura, e só essa identidade publica no tópico; nada é concedido no projeto do cliente."
  type = map(object({
    writer_identity = string
  }))
  default = {}
}

variable "operators" {
  description = "Quem pode entrar na VM por SSH (pelo IAP, sem porta aberta). Ex.: [\"user:voce@exemplo.com\"]. Dono do projeto já pode."
  type        = list(string)
  default     = []
}

variable "alert_email" {
  description = "E-mail que recebe o alerta de fila parada. Vazio: o alerta aparece só no console."
  type        = string
  default     = ""
}

variable "stalled_subscription_hours" {
  description = "Horas sem leitura até o alerta de fila parada (24 no uso normal; um valor baixo serve para testar o alerta)."
  type        = number
  default     = 24
}

variable "images_project_id" {
  description = "Projeto onde fica o registro das imagens do nó (o do nó da Verax, que o GitHub Actions já publica). A VM de homologação ganha só leitura nele."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.images_project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "images_location" {
  description = "Região do registro das imagens."
  type        = string
  default     = "us-east1"
}

variable "images_repository_id" {
  description = "Nome do registro das imagens."
  type        = string
  default     = "verax-control"
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
  description = "Orçamento mensal do projeto, na moeda da conta de faturamento. Avisos em 50%, 90% e 100%. Ligada o mês todo, a homologação custa o mesmo que um nó standard; parada, só o disco, os snapshots e o IP (infra/gcp/GUIA.md)."
  type        = number
  default     = 300
}
