# As variáveis de cada cliente chegam do plano de controle (o Job `cp-terraform`: as fixas do Job e as de cada execução,
# plano da fase 3, 4c, passo 4), já conferidas lá por regex. A conferência daqui é a segunda: o `plan` para antes de
# criar qualquer coisa com um valor fora do formato. Os valores vão para nomes de recursos e para os metadados da VM,
# de onde a instalação monta o node.conf (modules/node/node.tf, `install_metadata`).

# Fixas do Job (envs/control-plane/run.tf: NODES_PROJECT_ID, NODES_REGION e NODES_ZONE).

variable "project_id" {
  description = "ID do projeto da GCP dos nós de clientes (NODES_PROJECT_ID)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região do nó (NODES_REGION): São Paulo."
  type        = string
  default     = "southamerica-east1"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "Região da GCP inválida."
  }
}

variable "zone" {
  description = "Zona da VM (NODES_ZONE), dentro da região."
  type        = string
  default     = "southamerica-east1-b"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]-[a-z]$", var.zone)) && startswith(var.zone, "${var.region}-")
    error_message = "Zona da GCP inválida ou fora da região."
  }
}

# De cada execução (TENANT_SLUG, PLAN, NODE_VERSION, NODE_PACKAGE_SHA256, WEB_ORIGIN, API_ORIGIN, MAIL_FROM,
# SUBNET_CIDR, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_TENANT_NAME, CP_WORKER_SA e IMAGES_PROJECT_ID), mais o e-mail da
# conta de suporte (CP-10), os limites do plano e o servidor de envio do nó (SMTP_HOST, SMTP_PORT e SMTP_USER).

variable "slug" {
  description = "Subdomínio do cliente. Todo recurso do nó leva o prefixo `vx-<slug>` (a VM, a conta de serviço, a rede, os cofres). Mesma regra do plano de controle (apps/control-plane/src/tenants/tenant.schema.ts): 3 a 16 caracteres, para `vx-<slug>` caber nos nomes da GCP. Nunca muda na vida do nó: outro slug é outro nó (e outra conta de serviço, que a AWS do cliente não aceita)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}[a-z0-9]$", var.slug)) && substr(var.slug, 2, 2) != "--"
    error_message = "Slug inválido: 3 a 16 caracteres (minúsculas, números e hífen), começando com letra, sem terminar em hífen e sem hífen nas posições 3 e 4 juntas."
  }
}

variable "plan" {
  description = "Plano do nó (PLAN do node.conf): essencial, profissional ou enterprise. O preço configurável manda enterprise com os quatro limites (apps/control-plane/src/pricing/node-limits.ts). `interno` é só o nó da Verax e é recusado aqui."
  type        = string

  validation {
    condition     = contains(["essencial", "profissional", "enterprise"], var.plan)
    error_message = "Plano inválido: use essencial, profissional ou enterprise."
  }

  # No enterprise, os quatro limites vêm sempre dos ajustes (packages/shared/src/plans.ts): sem um deles, o nó não sobe.
  validation {
    condition = var.plan != "enterprise" || (
      var.plan_max_cloud_accounts != "" && var.plan_max_users != "" &&
      var.plan_monthly_gib != "" && var.plan_history_days != ""
    )
    error_message = "O plano enterprise exige os quatro limites: plan_max_cloud_accounts, plan_max_users, plan_monthly_gib e plan_history_days."
  }
}

# Os limites do plano (os ajustes PLAN_* do node.conf), nas faixas de packages/shared/src/plans.ts. Em texto, como vão
# para os metadados da VM (o executor passa os dígitos); vazio: o do plano.

variable "plan_max_cloud_accounts" {
  description = "PLAN_MAX_CLOUD_ACCOUNTS: contas cloud ativas (de 1 a 1000). Vazio: o do plano."
  type        = string
  default     = ""

  validation {
    condition     = var.plan_max_cloud_accounts == "" || (can(regex("^[1-9][0-9]{0,5}$", var.plan_max_cloud_accounts)) && try(tonumber(var.plan_max_cloud_accounts) >= 1 && tonumber(var.plan_max_cloud_accounts) <= 1000, false))
    error_message = "plan_max_cloud_accounts é vazio ou um número inteiro de 1 a 1000."
  }
}

variable "plan_max_users" {
  description = "PLAN_MAX_USERS: usuários do cliente (de 1 a 1000). Vazio: o do plano."
  type        = string
  default     = ""

  validation {
    condition     = var.plan_max_users == "" || (can(regex("^[1-9][0-9]{0,5}$", var.plan_max_users)) && try(tonumber(var.plan_max_users) >= 1 && tonumber(var.plan_max_users) <= 1000, false))
    error_message = "plan_max_users é vazio ou um número inteiro de 1 a 1000."
  }
}

variable "plan_monthly_gib" {
  description = "PLAN_MONTHLY_GIB: volume de log lido no mês, em GiB (de 1 a 100000). Vazio: o do plano."
  type        = string
  default     = ""

  validation {
    condition     = var.plan_monthly_gib == "" || (can(regex("^[1-9][0-9]{0,5}$", var.plan_monthly_gib)) && try(tonumber(var.plan_monthly_gib) >= 1 && tonumber(var.plan_monthly_gib) <= 100000, false))
    error_message = "plan_monthly_gib é vazio ou um número inteiro de 1 a 100000."
  }
}

variable "plan_history_days" {
  description = "PLAN_HISTORY_DAYS: dias de histórico (de 30 a 3650); o piso evita apagar dados por engano no expurgo. Vazio: o do plano."
  type        = string
  default     = ""

  validation {
    condition     = var.plan_history_days == "" || (can(regex("^[1-9][0-9]{0,5}$", var.plan_history_days)) && try(tonumber(var.plan_history_days) >= 30 && tonumber(var.plan_history_days) <= 3650, false))
    error_message = "plan_history_days é vazio ou um número inteiro de 30 a 3650."
  }
}

variable "node_version" {
  description = "Versão do pacote do nó: o release `node-vX.Y.Z` do manifesto assinado (scripts/node-release.sh, o mesmo formato)."
  type        = string

  validation {
    condition     = can(regex("^node-v(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})$", var.node_version))
    error_message = "Versão do nó inválida: use node-vX.Y.Z."
  }
}

variable "node_package_sha256" {
  description = "SHA-256 do pacote do nó dessa versão, do manifesto assinado (64 dígitos hexadecimais, minúsculos). A instalação confere antes de instalar."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.node_package_sha256))
    error_message = "SHA-256 inválido: 64 dígitos hexadecimais minúsculos."
  }
}

variable "web_origin" {
  description = "Endereço do painel do cliente (WEB_ORIGIN), só a origem: https e o nome, sem caminho, porta nem barra no fim. Ex.: https://<slug>.control.veraxsistemas.com.br."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.web_origin)) && length(var.web_origin) <= 261
    error_message = "WEB_ORIGIN inválida: https://<nome>, em minúsculas, sem caminho, porta nem barra no fim."
  }
}

variable "api_origin" {
  description = "Endereço da API do nó pelo túnel do Cloudflare (API_ORIGIN), só a origem. Ex.: https://api-<slug>.veraxsistemas.com.br."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.api_origin)) && length(var.api_origin) <= 261
    error_message = "API_ORIGIN inválida: https://<nome>, em minúsculas, sem caminho, porta nem barra no fim."
  }

  validation {
    condition     = var.api_origin != var.web_origin
    error_message = "O painel e a API têm endereços diferentes."
  }
}

# A mesma forma do `z.email()` do zod 4, que o checkout (o e-mail do admin) e a API do nó (MAIL_FROM) usam: um e-mail
# aceito lá não pode ser recusado aqui, senão o provisionamento falharia depois da compra. Sem lookahead no RE2 do
# Terraform: o ponto no começo e os dois pontos seguidos são conferidos à parte. O apóstrofo é aceito, como no zod: a
# instalação trata o valor como dado e nunca o interpreta num shell.

variable "mail_from" {
  description = "Remetente dos e-mails do nó (MAIL_FROM), só o endereço (a API do nó não aceita \"Nome <e-mail>\")."
  type        = string

  validation {
    condition = (
      length(var.mail_from) <= 254 && !startswith(var.mail_from, ".") && !strcontains(var.mail_from, "..") &&
      can(regex("^[A-Za-z0-9_'+.-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}$", var.mail_from))
    )
    error_message = "MAIL_FROM inválido: só o endereço de e-mail."
  }
}

# O e-mail do nó (SMTP_HOST, SMTP_PORT e SMTP_USER do executor; `SMTP_*_NODES` do plano de controle): a caixa de envio
# comum aos nós de clientes, de qualquer provedor SMTP com TLS. As três juntas ou nenhuma: vazias (o padrão), o nó nasce
# com `MAIL_TRANSPORT=none`. A senha nunca passa por aqui: o cp-worker a grava no cofre `smtp-password` do nó
# (control_plane.tf), e o nó a lê na partida. Os formatos são os do `boot-install.sh` (cada valor vira uma linha do
# node.conf, que o nó lê com `source`).

variable "smtp_host" {
  description = "Servidor de envio do nó (SMTP_HOST): o nome, em minúsculas, sem porta. Vazio: o nó sem e-mail."
  type        = string
  default     = ""

  validation {
    condition     = var.smtp_host == "" || (length(var.smtp_host) <= 253 && can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.smtp_host)))
    error_message = "smtp_host é vazio ou o nome do servidor, em minúsculas (ex.: smtp.exemplo.com), sem porta."
  }

  validation {
    condition     = (var.smtp_host == "") == (var.smtp_port == "") && (var.smtp_host == "") == (var.smtp_user == "")
    error_message = "smtp_host, smtp_port e smtp_user vão juntos: os três preenchidos (o nó com e-mail) ou os três vazios."
  }
}

variable "smtp_port" {
  description = "Porta do servidor de envio (SMTP_PORT), de 1 a 65535: 465 (TLS desde o início) ou outra com STARTTLS obrigatório. A GCP bloqueia a saída pela 25. Vazio: o nó sem e-mail."
  type        = string
  default     = ""

  validation {
    condition     = var.smtp_port == "" || (can(regex("^[1-9][0-9]{0,4}$", var.smtp_port)) && try(tonumber(var.smtp_port) <= 65535, false))
    error_message = "smtp_port é vazio ou um número inteiro de 1 a 65535."
  }
}

variable "smtp_user" {
  description = "Usuário do servidor de envio (SMTP_USER): letras, números e @ . _ + - (até 254), começando por letra ou número. Vazio: o nó sem e-mail."
  type        = string
  default     = ""

  validation {
    condition     = var.smtp_user == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9@._+-]{0,253}$", var.smtp_user))
    error_message = "smtp_user é vazio ou tem só letras, números e @ . _ + - (até 254), começando por letra ou número."
  }
}

variable "subnet_cidr" {
  description = "Faixa da rede própria do nó, alocada pelo plano de controle (`10.<n>.0.0/24`, um contador). Cada nó tem a própria rede, sem ligação com a dos outros."
  type        = string

  validation {
    condition     = can(regex("^10\\.[0-9]{1,3}\\.[0-9]{1,3}\\.0/24$", var.subnet_cidr)) && try("${cidrhost(var.subnet_cidr, 0)}/24" == var.subnet_cidr, false)
    error_message = "Faixa inválida: uma /24 dentro de 10.0.0.0/8, pelo endereço da rede (ex.: 10.12.0.0/24)."
  }
}

variable "bootstrap_admin_email" {
  description = "E-mail do primeiro admin do cliente (o do checkout), que a instalação cria com uma senha temporária no cofre `admin-bootstrap` (CP-10). Fica nos metadados da VM (`verax-admin-email`) enquanto o nó existir."
  type        = string

  validation {
    condition = (
      length(var.bootstrap_admin_email) <= 254 && !startswith(var.bootstrap_admin_email, ".") && !strcontains(var.bootstrap_admin_email, "..") &&
      can(regex("^[A-Za-z0-9_'+.-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}$", var.bootstrap_admin_email))
    )
    error_message = "E-mail do primeiro admin inválido."
  }
}

variable "bootstrap_support_email" {
  description = "E-mail da conta de suporte da Verax no nó, que a instalação cria com uma senha temporária no cofre `support-bootstrap` (CP-10; só o responsável lê). Sem padrão: vem do plano de controle, e nenhum endereço real fica no repositório."
  type        = string

  validation {
    condition = (
      length(var.bootstrap_support_email) <= 254 && !startswith(var.bootstrap_support_email, ".") && !strcontains(var.bootstrap_support_email, "..") &&
      can(regex("^[A-Za-z0-9_'+.-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}$", var.bootstrap_support_email))
    )
    error_message = "E-mail da conta de suporte inválido."
  }

  validation {
    condition     = lower(var.bootstrap_support_email) != lower(var.bootstrap_admin_email)
    error_message = "A conta de suporte e o primeiro admin do cliente têm e-mails diferentes."
  }
}

variable "bootstrap_tenant_name" {
  description = "Nome do cliente no nó (o nome da empresa do checkout): de 2 a 120 caracteres, o limite do nó (`Tenant.name` é `VarChar(120)`), sem espaço nas pontas e sem caractere de controle, a mesma regra do checkout (`companyNameSchema`, em apps/control-plane/src/tenants/tenant.schema.ts). Chega inteiro, sem corte. Texto livre (`verax-tenant-name` nos metadados): a instalação trata como dado."
  type        = string

  validation {
    condition     = length(var.bootstrap_tenant_name) >= 2 && length(var.bootstrap_tenant_name) <= 120
    error_message = "Nome do cliente com tamanho inválido: de 2 a 120 caracteres, o limite do nó e do checkout."
  }

  validation {
    condition = (
      trimspace(var.bootstrap_tenant_name) == var.bootstrap_tenant_name &&
      !can(regex("[[:cntrl:]]", var.bootstrap_tenant_name))
    )
    error_message = "Nome do cliente inválido: sem espaço nas pontas e sem quebra de linha nem outro caractere de controle."
  }
}

variable "control_plane_sa" {
  description = "Conta do cp-worker (CP_WORKER_SA do Job): ganha, só nos cofres deste nó, a leitura e a destruição da senha temporária do primeiro admin, a gravação do token do túnel (e, com o e-mail do nó, a da senha da caixa de envio) e a destruição das versões da chave do cofre de credenciais (control_plane.tf). Só a conta `cp-worker` é aceita: dar isso a outra conta do plano de controle (o cp-public, o cp-terraform) abriria a senha do admin a quem não a revela."
  type        = string

  validation {
    condition     = can(regex("^cp-worker@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", var.control_plane_sa))
    error_message = "control_plane_sa é o e-mail da conta cp-worker do plano de controle (cp-worker@<projeto>.iam.gserviceaccount.com)."
  }
}

# De onde a VM baixa a API e as migrations (IMAGES_REPOSITORY do executor, `NODE_IMAGES_REPOSITORY` do plano de
# controle), pelo digest do manifesto assinado: os mesmos dois formatos que a instalação sem operador aceita
# (`boot-install.sh`). Decisão do CP-07, à espera do responsável: o GHCR público por padrão. A limpeza do Artifact
# Registry (envs/verax/images.tf) apaga, depois de 30 dias, as versões fora das 3 mais recentes, e um cliente novo numa
# versão mais antiga pararia em `install_failed`; o GHCR não tem limpeza e não pede login.
variable "images_repository" {
  description = "Registro das imagens do Verax para a VM: `ghcr.io/<dono>/<repositório>` (público, sem login; o do manifesto) ou `<região>-docker.pkg.dev/<projeto>/<registro>` (o Artifact Registry do projeto da Verax; a conta da VM ganha só leitura nele, como na homologação)."
  type        = string
  default     = "ghcr.io/williandotdev/verax-control"

  validation {
    condition = (
      can(regex("^ghcr\\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$", var.images_repository)) ||
      can(regex("^[a-z0-9-]+-docker\\.pkg\\.dev/[a-z][a-z0-9-]{4,28}[a-z0-9]/[a-z0-9-]{1,63}$", var.images_repository))
    )
    error_message = "images_repository é ghcr.io/<dono>/<repositório> ou <região>-docker.pkg.dev/<projeto>/<registro>."
  }
}

variable "deletion_protection" {
  description = "Proteção da VM contra exclusão. Verdadeiro em toda a vida do nó; a Exclusão 1 do cliente (CP-11) aplica antes com falso, e só então destrói (docs/ARQUITETURA.md, \"Exclusão em dois tempos\")."
  type        = bool
  default     = true
}
