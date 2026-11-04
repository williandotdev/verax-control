variable "project_id" {
  description = "ID do projeto da GCP onde fica a chave de release. Recomendado: o do nó da Verax (envs/verax). Nunca o do plano de controle, onde fica a chave das licenças."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Local do chaveiro do Cloud KMS. Assinar é uma chamada pequena por versão: o lugar não pesa no custo nem no tempo."
  type        = string
  default     = "us-east1"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "Use uma região da GCP (ex.: us-east1)."
  }
}

variable "github_oidc_repository" {
  description = "Repositório do GitHub como aparece no `sub` do token OIDC (o subject imutável, com os IDs fixos: dono@id/repo@id), o mesmo dos environments `imagens` e `painel`. Um repositório recriado com o mesmo nome tem outro ID e não entra."
  type        = string
  default     = "williandotdev@92734416/verax-control@1441377752"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+@[0-9]+/[A-Za-z0-9._-]+@[0-9]+$", var.github_oidc_repository))
    error_message = "Use o formato dono@id/repositório@id."
  }
}

variable "github_repository" {
  description = "Repositório do GitHub pelo nome (dono/nome), como aparece no `workflow_ref` do token OIDC. Só o workflow deste arquivo, na main, assina."
  type        = string
  default     = "williandotdev/verax-control"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "Use o formato dono/nome."
  }
}

variable "github_environment" {
  description = "Environment do GitHub que assina. Configure-o no GitHub com aprovação obrigatória e só a branch main (docs/runbooks/versao-no.md)."
  type        = string
  default     = "release"

  validation {
    # Os environments que já existem fazem outras coisas e não pedem aprovação: nenhum deles pode assinar.
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.github_environment)) && !contains(["imagens", "painel", "control-plane"], var.github_environment)
    error_message = "Use um environment só para a assinatura (o padrão é release), nunca imagens, painel ou control-plane."
  }
}

variable "github_workflow" {
  description = "Arquivo do workflow que assina, em .github/workflows/."
  type        = string
  default     = "versao-no.yml"

  validation {
    condition     = can(regex("^[a-z0-9-]+\\.ya?ml$", var.github_workflow))
    error_message = "Use só o nome do arquivo (ex.: versao-no.yml)."
  }
}

variable "release_key_version" {
  description = "Versão da chave que o workflow usa para assinar. Na troca de chave, crie a versão nova (docs/runbooks/versao-no.md), ponha a pública no pacote e só então suba este número."
  type        = number
  default     = 1

  validation {
    condition     = var.release_key_version >= 1 && floor(var.release_key_version) == var.release_key_version
    error_message = "A versão da chave é um inteiro a partir de 1."
  }
}
