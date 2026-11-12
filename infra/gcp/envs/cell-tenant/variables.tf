# As variáveis de cada cliente da célula chegam do plano de controle (o Job `cp-terraform`), já conferidas lá por regex
# (`apps/control-plane/src/provisioning/executor-env.ts` e `infra/control-plane/terraform/entrypoint.sh`). A conferência
# daqui é a terceira: o `plan` para antes de criar qualquer coisa com um valor fora do formato.

variable "project_id" {
  description = "Projeto da GCP da célula (CELL_PROJECT_ID): o do envs/celula, onde ficam a VM e as contas de cada cliente."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região da célula (CELL_REGION): o cofre e os tópicos guardam os dados só nela."
  type        = string
  default     = "southamerica-east1"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "Região da GCP inválida."
  }
}

variable "cell_id" {
  description = "Identificador da célula (CELL_ID, o `cell_id` do envs/celula): entra no nome dos tópicos da GCP do cliente."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.cell_id))
    error_message = "Use de 2 a 8 caracteres: minúsculas e números, começando com letra."
  }
}

variable "slug" {
  description = "Subdomínio do cliente (TENANT_SLUG): nome da conta de serviço (`vxt-<slug>`) e do cofre do primeiro acesso. A regra do plano de controle e da API: 3 a 16 caracteres, minúsculas, números e hífen, começando com letra, sem `--` na 3.ª e 4.ª posições."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}[a-z0-9]$", var.slug)) && substr(var.slug, 2, 2) != "--"
    error_message = "Subdomínio inválido."
  }
}

variable "cell_node_service_account" {
  description = "Conta de serviço da VM da célula (CELL_NODE_SA; a saída `cell.node_service_account` do envs/celula): emite o token do cliente, grava a senha do primeiro acesso e lê os tópicos da GCP dele."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]@${var.project_id}\\.iam\\.gserviceaccount\\.com$", var.cell_node_service_account))
    error_message = "Use o e-mail da conta de serviço da VM da célula, no projeto da célula."
  }
}

variable "control_plane_sa" {
  description = "Conta do cp-worker (CP_WORKER_SA): lê e destrói a senha do primeiro acesso, e desativa e reativa a conta de serviço do cliente."
  type        = string

  validation {
    condition     = can(regex("^cp-worker@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", var.control_plane_sa))
    error_message = "Use o e-mail da conta cp-worker do projeto do plano de controle."
  }
}

variable "gcp_sources" {
  description = "Os projetos GCP do cliente (GCP_SOURCES), pelo UUID da conta cloud no painel: o projeto e a identidade do sink que o cliente criou (`writer_identity`). Cada um ganha tópico e assinatura `vxc-<célula>-gcp-<UUID>`, um nome que nunca volta (o UUID é da conta, e uma conta apagada não renasce), e só aquela identidade publica nele. Vazio: nenhum."
  type = map(object({
    project_id      = string
    writer_identity = string
  }))
  default = {}

  validation {
    condition     = length(var.gcp_sources) <= 50
    error_message = "No máximo 50 projetos por cliente."
  }

  validation {
    condition     = alltrue([for id in keys(var.gcp_sources) : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id))])
    error_message = "Cada chave é o UUID da conta cloud, em minúsculas."
  }

  validation {
    condition     = alltrue([for source in values(var.gcp_sources) : can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", source.project_id))])
    error_message = "Cada project_id precisa ser um ID de projeto da GCP."
  }

  # Só o agente do Cloud Logging do projeto do cliente (a mesma regra do módulo do nó e da API, packages/shared).
  validation {
    condition     = alltrue([for source in values(var.gcp_sources) : can(regex("^serviceAccount:service-[0-9]+@gcp-sa-logging\\.iam\\.gserviceaccount\\.com$", source.writer_identity))])
    error_message = "A writer_identity é a identidade do sink do cliente: serviceAccount:service-<número>@gcp-sa-logging.iam.gserviceaccount.com."
  }

  # Uma identidade de sink é de um projeto só, e um projeto é de uma conta só.
  validation {
    condition = (
      length(distinct([for source in values(var.gcp_sources) : source.writer_identity])) == length(var.gcp_sources) &&
      length(distinct([for source in values(var.gcp_sources) : source.project_id])) == length(var.gcp_sources)
    )
    error_message = "A mesma writer_identity ou o mesmo project_id aparece em mais de uma conta."
  }
}
