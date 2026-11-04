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
  description = "Projetos cujos logs de segurança vão para o nó, com o sink criado por este Terraform (é preciso ser dono deles: os da Verax e os de teste). Em cada um, um coletor (sink) só copia; nada existente muda. Projeto de cliente vai em `customer_projects`."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for project in var.monitored_projects : can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", project))])
    error_message = "Cada item precisa ser um ID de projeto da GCP."
  }
}

variable "customer_projects" {
  description = "Projetos GCP de clientes, pelo ID, cada um com a identidade de escrita (`writer_identity`) do sink que o próprio cliente criou no projeto dele apontando para o tópico do nó (o comando pronto de Contas cloud; a identidade é a que ele colou no painel). Para cada um, o nó ganha tópico e assinatura, e só essa identidade pode publicar no tópico. Nada é criado nem concedido no projeto do cliente. Ex.: { \"projeto-do-cliente\" = { writer_identity = \"serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com\" } }."
  type = map(object({
    writer_identity = string
  }))
  default = {}

  validation {
    condition     = alltrue([for project in keys(var.customer_projects) : can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", project))])
    error_message = "Cada chave precisa ser um ID de projeto da GCP."
  }

  # Só o agente do Cloud Logging do projeto do cliente (`service-<número do projeto>@gcp-sa-logging`), que a GCP cria
  # para o sink. Uma conta de serviço comum, uma pessoa, a identidade compartilhada antiga (cloud-logs@system) ou o
  # agente de uma pasta ou organização daria a publicação no tópico a quem não é o sink daquele projeto. A API aceita a
  # mesma regra (packages/shared); um teste confere que as duas continuam iguais.
  validation {
    condition     = alltrue([for project in values(var.customer_projects) : can(regex("^serviceAccount:service-[0-9]+@gcp-sa-logging\\.iam\\.gserviceaccount\\.com$", project.writer_identity))])
    error_message = "A writer_identity é a identidade do sink do cliente, como o gcloud mostra: serviceAccount:service-<número>@gcp-sa-logging.iam.gserviceaccount.com."
  }

  validation {
    condition     = length(setintersection(keys(var.customer_projects), var.monitored_projects)) == 0
    error_message = "Um projeto fica em monitored_projects (o Terraform cria o sink nele) ou em customer_projects (o cliente cria), nunca nos dois."
  }

  # A identidade é do sink de um projeto só. Repetida em dois projetos (uma colada errada no painel), daria ao sink de
  # um a publicação no tópico do outro, e o apply passaria: o IAM aceita o mesmo membro em dois tópicos. A API recusa
  # a repetição entre as contas do mesmo cliente pela mesma razão.
  validation {
    condition     = length(distinct([for project in values(var.customer_projects) : project.writer_identity])) == length(var.customer_projects)
    error_message = "A mesma writer_identity aparece em mais de um projeto: cada identidade de sink é de um projeto só."
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

variable "wazuh_agents" {
  description = "Agentes do Wazuh nas instâncias do cliente: um IP fixo de entrada (regra de encaminhamento para a VM, sem IP externo nela; a saída continua pelo Cloud NAT) nas portas TCP 1514 e 1515. Só no perfil standard. Falso por padrão: nada é criado. Liga junto com WAZUH_AGENTS=true no node.conf (docs/runbooks/onboarding-cliente.md)."
  type        = bool
  default     = false

  validation {
    condition     = !var.wazuh_agents || var.node_profile == "standard"
    error_message = "Os agentes do Wazuh só existem no perfil standard (o lean não tem o Wazuh)."
  }
}

variable "wazuh_agents_sources" {
  description = "Faixas de IP de saída do cliente que podem chegar às portas 1514 e 1515 (IPv4, de /16 a /32, no endereço da rede). Vazia: nenhuma regra de entrada, e o painel diz que a liberação está pendente. Ex.: [\"198.51.100.0/28\", \"192.0.2.15/32\"]."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.wazuh_agents_sources) == 0 || var.wazuh_agents
    error_message = "As faixas dos agentes só valem com wazuh_agents = true."
  }

  # O endereço da rede (sem bit de host) e no máximo /16: nada de 0.0.0.0/0 nem de faixas largas que abririam as portas
  # para a internet. O install.sh e o start.sh aceitam o mesmo formato em WAZUH_AGENTS_SOURCES.
  validation {
    condition = alltrue([for cidr in var.wazuh_agents_sources : try(
      can(regex("^[0-9]{1,3}([.][0-9]{1,3}){3}/[0-9]{1,2}$", cidr)) &&
      tonumber(split("/", cidr)[1]) >= 16 &&
      "${cidrhost(cidr, 0)}/${split("/", cidr)[1]}" == cidr,
      false
    )])
    error_message = "Cada faixa é um IPv4 de /16 a /32, escrito pelo endereço da rede (ex.: 198.51.100.0/28 ou 192.0.2.15/32)."
  }

  validation {
    condition     = length(var.wazuh_agents_sources) <= 20 && length(distinct(var.wazuh_agents_sources)) == length(var.wazuh_agents_sources)
    error_message = "No máximo 20 faixas, sem repetição."
  }
}
