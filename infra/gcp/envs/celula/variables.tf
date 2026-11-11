variable "project_id" {
  description = "ID do projeto da GCP da célula (o do nó da Verax, onde fica o registro das imagens)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região da célula: São Paulo, a mesma dos nós de clientes."
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
  default     = "verax-celula"
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
  default     = "10.82.0.0/24"
}

variable "monitored_projects" {
  description = "Projetos de teste cujos logs de segurança vão para o nó (o sink é criado em cada um; você precisa ser dono deles). Projeto de cliente vai em customer_projects."
  type        = list(string)
  default     = []
}

variable "customer_projects" {
  description = "Projetos de clientes em que o próprio cliente criou o sink com o comando de Contas cloud: o ID do projeto e a identidade do sink que ele colou no painel. O nó ganha tópico e assinatura, e só essa identidade publica no tópico; nada é concedido no projeto do cliente."
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

variable "wazuh_agents" {
  description = "Agentes do Wazuh nas instâncias de teste: IP fixo de entrada nas portas TCP 1514 e 1515 (o módulo explica). Falso por padrão; liga junto com WAZUH_AGENTS=true no node.conf."
  type        = bool
  default     = false
}

variable "wazuh_agents_sources" {
  description = "Faixas de IP de saída das instâncias de teste que podem chegar às portas dos agentes (IPv4 de /16 a /32). Vazia: nenhuma regra de entrada."
  type        = list(string)
  default     = []
}

variable "images_project_id" {
  description = "Projeto onde fica o registro das imagens do nó (o do nó da Verax, que o GitHub Actions já publica). A VM da célula ganha só leitura nele."
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
  description = "Orçamento mensal do projeto, na moeda da conta de faturamento. Avisos em 50%, 90% e 100%. Avisa sobre o projeto inteiro (a célula e o que mais estiver nele)."
  type        = number
  default     = 300
}

variable "cell_id" {
  description = "Identificador da célula no plano de controle (o registro `cells/<id>`): entra no nome dos tópicos do canal (`vxc-<id>-commands` e `vxc-<id>-reports`), da conta do push, do bucket de exportações e na pasta das exportações (`<id>/<cliente>/...`). Não muda na vida da célula: trocar recria o canal e o bucket."
  type        = string
  default     = "sp1"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.cell_id))
    error_message = "Use de 2 a 8 caracteres: minúsculas e números, começando com letra (ex.: sp1)."
  }
}

variable "backup_retention_days" {
  description = "Dias de retenção dos backups do banco da célula. 85: o último backup com um cliente expurgado em D+1 sai até cerca de D+95 (mais os 7 dias de exclusão reversível e o atraso do ciclo de vida), dentro da promessa dos 100 dias. Os nós dedicados continuam com 90."
  type        = number
  default     = 85

  validation {
    condition     = var.backup_retention_days >= 30 && var.backup_retention_days <= 85 && floor(var.backup_retention_days) == var.backup_retention_days
    error_message = "Na célula, use um número inteiro de 30 a 85 dias: mais que 85 passa da promessa dos 100 dias depois do expurgo."
  }
}

variable "control_plane_project_id" {
  description = "Projeto do plano de controle (envs/control-plane), onde estão as contas `cp-worker` e `cp-terraform`. Vazio (o padrão): nada do canal com o plano de controle é criado, e a célula fica como antes. Preenchido junto com `control_plane_worker_url`: os tópicos de comandos e de relatórios, com o IAM de cada um, e a assinatura push dos relatórios para o cp-worker (cell.tf)."
  type        = string
  default     = ""

  validation {
    condition     = var.control_plane_project_id == "" || can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.control_plane_project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "control_plane_worker_url" {
  description = "Endereço do serviço cp-worker no Cloud Run (`https://cp-worker-....run.app`, sem barra no fim; `terraform output` do envs/control-plane). A assinatura push dos relatórios entrega em `<endereço>/internal/cells/<cell_id>/reports`, com um token OIDC cuja audiência é este endereço. Preenchido junto com `control_plane_project_id`, ou os dois vazios."
  type        = string
  default     = ""

  validation {
    condition     = var.control_plane_worker_url == "" || (length(var.control_plane_worker_url) <= 200 && can(regex("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.control_plane_worker_url)))
    error_message = "Use o endereço https do cp-worker, só o host (ex.: https://cp-worker-abc123-rj.a.run.app), sem caminho nem barra no fim."
  }

  # O canal é inteiro ou nada: tópicos sem a assinatura push perderiam os relatórios (mensagem publicada num tópico sem
  # assinatura some), e a assinatura sem o projeto não teria quem publicar os comandos.
  validation {
    condition     = (var.control_plane_worker_url == "") == (var.control_plane_project_id == "")
    error_message = "control_plane_project_id e control_plane_worker_url andam juntos: os dois preenchidos ou os dois vazios."
  }
}
