variable "project_id" {
  description = "ID do projeto da GCP onde o nó fica."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região do nó."
  type        = string
}

variable "zone" {
  description = "Zona da VM (dentro da região)."
  type        = string
}

variable "name_prefix" {
  description = "Prefixo de todos os recursos do nó. Nada fora deste prefixo é tocado."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{3,18}$", var.name_prefix))
    error_message = "Use de 4 a 19 caracteres: minúsculas, números e hífen, começando com letra."
  }
}

variable "node_profile" {
  description = "Perfil do nó: `lean` (o da Verax: e2-micro, 30 GB pd-standard, snapshot semanal de 28 dias, sem Wazuh) ou `standard` (nó de cliente: e2-standard-2, 60 GB pd-balanced, snapshot diário de 7 dias, IP fixo no NAT, com o Wazuh)."
  type        = string

  validation {
    condition     = contains(["lean", "standard"], var.node_profile)
    error_message = "Use lean ou standard."
  }
}

variable "machine_type" {
  description = "Tamanho da VM. Nulo: o do perfil (e2-micro no lean, e2-standard-2 no standard). No standard, a e2-standard-4 é o plano B."
  type        = string
  default     = null
}

variable "disk_gb" {
  description = "Disco da VM (sistema, banco e dados do nó), em GB. Nulo: o do perfil (30 no lean, 60 no standard). O disco só cresce."
  type        = number
  default     = null

  validation {
    condition     = var.disk_gb == null || (coalesce(var.disk_gb, 0) >= 20 && coalesce(var.disk_gb, 0) <= 500)
    error_message = "O disco precisa ter de 20 a 500 GB."
  }
}

variable "subnet_cidr" {
  description = "Faixa de IPs da rede própria do nó. Não pode coincidir com outra rede do projeto."
  type        = string
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

variable "operators" {
  description = "Quem pode entrar na VM por SSH (pelo IAP, sem porta aberta). Ex.: [\"user:voce@exemplo.com\"]."
  type        = list(string)
  default     = []
}

variable "deletion_protection" {
  description = "Proteção da VM contra exclusão. Só sai (por um `apply` antes) para desfazer o nó ou para recriar a VM numa manutenção planejada (veja o GUIA.md)."
  type        = bool
  default     = true
}

variable "legacy_startup_script" {
  description = "Script de boot de um nó criado antes do módulo (o da Verax). O provider recria a VM quando o `metadata_startup_script` muda, então esse nó continua com o arquivo dele, idêntico. Nulo: o script do módulo, com swap cifrado."
  type        = string
  default     = null
}

variable "pubsub_storage_in_region" {
  description = "Guarda as mensagens dos tópicos de logs só na região do nó (`message_storage_policy`)."
  type        = bool
  default     = true
}

variable "credentials_vault" {
  description = "Cria o cofre `credentials-key` (chave do cofre de credenciais do nó; a VM gera a chave e grava a versão)."
  type        = bool
  default     = true
}

variable "bootstrap_secret" {
  description = "Cria o cofre `admin-bootstrap`, onde a VM grava a senha temporária do primeiro admin numa instalação sem SSH."
  type        = bool
  default     = true
}

variable "turnstile_secret" {
  description = "Cria o cofre `turnstile-secret-key` (chave secreta do Cloudflare Turnstile, que o nó lê para conferir o desafio do login). Falso por padrão: o nó da Verax, já no ar, liga numa mudança no lugar."
  type        = bool
  default     = false
}

variable "stalled_subscription_alert" {
  description = "Cria o alerta de fila parada: alguma assinatura de logs com mensagem sem leitura há mais de `stalled_subscription_hours`."
  type        = bool
  default     = true
}

variable "stalled_subscription_hours" {
  description = "Horas sem leitura até o alerta de fila parada. As mensagens ficam 7 dias na assinatura; um valor baixo serve para testar o alerta."
  type        = number
  default     = 24

  validation {
    condition     = var.stalled_subscription_hours >= 1 && var.stalled_subscription_hours <= 144
    error_message = "Use de 1 a 144 horas (antes dos 7 dias de retenção)."
  }
}

variable "alert_email" {
  description = "E-mail que recebe os alertas do nó. Vazio: o alerta aparece só no console."
  type        = string
  default     = ""
}
