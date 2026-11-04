variable "project_id" {
  description = "ID do projeto da GCP da Verax que hospeda o Firebase dos painéis. O plano de controle fica nele (plano da fase 3, decisão 3 e risco 4)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "region" {
  description = "Região de tudo (Cloud Run, filas, relógio, Firestore, segredos e registro das imagens): São Paulo, a mesma dos nós de clientes."
  type        = string
  default     = "southamerica-east1"
}

variable "services_enabled" {
  description = "Cria os serviços do Cloud Run (cp-public e cp-worker), o Job cp-terraform, os jobs do Scheduler e o rewrite do Hosting. Deixe false na primeira subida: o Cloud Run recusa subir com um segredo sem versão, e os cinco segredos nascem vazios. Depois de gravá-los (GUIA, plano de controle, passo 4), mude para true e aplique de novo."
  type        = bool
  default     = false
}

variable "public_image" {
  description = "Imagem do cp-public. O padrão é a imagem de exemplo do Google, só para a primeira subida; o workflow de implantação troca pela imagem do plano de controle, e o Terraform não mexe mais nela (ignore_changes em run.tf)."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "worker_image" {
  description = "Imagem do cp-worker (a mesma do cp-public, com ROLE=worker). Mesma regra do public_image."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "terraform_image" {
  description = "Imagem do Job cp-terraform (Terraform 1.17.1 com o provider espelhado, CP-07). O padrão é a imagem de exemplo de job do Google, só para a primeira subida; o workflow troca, e o Terraform não mexe mais nela."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/job"
}

variable "worker_ingress" {
  description = "Entrada do cp-worker. INGRESS_TRAFFIC_INTERNAL_ONLY (padrão): só o Cloud Tasks e o Cloud Scheduler deste projeto chegam nele, e ainda com o IAM. Para as operações do responsável a partir da sua máquina (resume, delete-now, export, com `gcloud auth print-identity-token`), mude para INGRESS_TRAFFIC_ALL: o IAM continua exigindo o token de identidade."
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_ALL"], var.worker_ingress)
    error_message = "Use INGRESS_TRAFFIC_INTERNAL_ONLY ou INGRESS_TRAFFIC_ALL."
  }
}

variable "owner_principals" {
  description = "Quem opera o plano de controle além das contas de serviço: pode chamar o cp-worker (run.invoker) e entra em OWNER_PRINCIPALS, que o worker confere no token. Ex.: [\"user:voce@exemplo.com\"]. Só user: e serviceAccount:, porque o worker compara o e-mail do token; grupo não tem e-mail no token."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for p in var.owner_principals : can(regex("^(user|serviceAccount):[^:@[:space:]]+@[^:@[:space:]]+$", p))])
    error_message = "Cada item precisa ser user:e-mail ou serviceAccount:e-mail."
  }
}

variable "alert_email" {
  description = "E-mail que recebe os alertas (provisionamento com falha e assinatura inválida no webhook) e vai em OWNER_ALERT_EMAIL. Vazio: os alertas aparecem só no console."
  type        = string
  default     = ""
}

locals {
  # Chaves que o responsável não define em `service_env` nem em `worker_env`: as que o Terraform deriva de outras
  # variáveis (cada uma tem a sua: alert_email, nodes_project_id, firebase_panel_projects...), as que o workflow de
  # implantação reafirma (ROLE, NODE_ENV), a que o Cloud Run reserva (PORT) e os cinco segredos, que vêm do Secret
  # Manager. Recusar é melhor do que ignorar em silêncio (o `merge` de run.tf põe o que o Terraform sabe por último).
  reserved_env_keys = "^(ROLE|NODE_ENV|PORT|FIRESTORE_DATABASE|TASKS_.*|WORKER_URL|WORKER_SA_EMAIL|SCHEDULER_SA_EMAIL|OWNER_PRINCIPALS|OWNER_ALERT_EMAIL|TERRAFORM_JOB_NAME|NODES_.*|TFSTATE_BUCKET|IMAGES_PROJECT_ID|RELEASE_BUCKET|FIREBASE_PANEL_PROJECTS|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ZONE_ID|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|CLOUDFLARE_API_TOKEN|SMTP_PASSWORD|COOKIE_KEY)$"
}

variable "service_env" {
  description = "Variáveis de ambiente dos dois serviços (plano, seção 2.5), por cima dos padrões de `service_env_defaults` em run.tf; uma chave igual substitui o padrão. Só o que não é segredo nem o Terraform deriva (a validação recusa essas chaves). Nada de SMTP nem remetente aqui: isso é só do cp-worker (`worker_env`). Ex.: { TERMS_VERSION = \"2026-11-01\", TRUST_PROXY_HOPS = \"1\" }."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for name in keys(var.service_env) : !can(regex(local.reserved_env_keys, name))])
    error_message = "service_env não aceita ROLE, NODE_ENV, PORT, os segredos (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, CLOUDFLARE_API_TOKEN, SMTP_PASSWORD, COOKIE_KEY) nem o que o Terraform deriva de outras variáveis (FIRESTORE_DATABASE, TASKS_*, WORKER_URL, WORKER_SA_EMAIL, SCHEDULER_SA_EMAIL, OWNER_PRINCIPALS, OWNER_ALERT_EMAIL, TERRAFORM_JOB_NAME, NODES_*, TFSTATE_BUCKET, IMAGES_PROJECT_ID, RELEASE_BUCKET, FIREBASE_PANEL_PROJECTS, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID): use a variável própria de cada um."
  }

  validation {
    condition     = alltrue([for name in keys(var.service_env) : !can(regex("^(SMTP_.*|MAIL_FROM.*)$", name))])
    error_message = "SMTP_* e MAIL_FROM* são só do cp-worker: use worker_env."
  }
}

variable "worker_env" {
  description = "Variáveis de ambiente só do cp-worker (plano, seção 2.5: e-mail e provisionamento), por cima de `service_env` e dos padrões de SMTP em run.tf. O cp-public não as recebe. Ex.: { SMTP_USER = \"nao-responda@exemplo.com\", MAIL_FROM = \"Verax Control <nao-responda@exemplo.com>\", MAIL_FROM_NODES = \"nao-responda@exemplo.com\", NODE_RELEASE = \"v1.2.3\", PROVISIONING_ENABLED = \"true\" }."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for name in keys(var.worker_env) : !can(regex(local.reserved_env_keys, name))])
    error_message = "worker_env não aceita ROLE, NODE_ENV, PORT, os segredos nem o que o Terraform deriva de outras variáveis (a mesma lista de service_env): use a variável própria de cada um."
  }
}

variable "cloudflare_account_id" {
  description = "ID da conta do Cloudflare (CLOUDFLARE_ACCOUNT_ID do cp-worker). Vazio até o provisionamento ser ligado."
  type        = string
  default     = ""

  validation {
    condition     = var.cloudflare_account_id == "" || can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "ID de conta do Cloudflare: 32 caracteres hexadecimais."
  }
}

variable "cloudflare_zone_id" {
  description = "ID da zona veraxsistemas.com.br no Cloudflare (CLOUDFLARE_ZONE_ID do cp-worker). Vazio até o provisionamento ser ligado."
  type        = string
  default     = ""

  validation {
    condition     = var.cloudflare_zone_id == "" || can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "ID de zona do Cloudflare: 32 caracteres hexadecimais."
  }
}

variable "nodes_project_id" {
  description = "Projeto dos nós de clientes (criado na primeira venda). Vazio: nada é concedido lá. Preenchido: os papéis da seção 2.2 do plano para cp-terraform e cp-worker nesse projeto e no bucket do estado dele (cross_project.tf). Exige o envs/nodes-platform aplicado antes (bucket do estado e APIs)."
  type        = string
  default     = ""

  validation {
    condition     = var.nodes_project_id == "" || can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.nodes_project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "nodes_zone" {
  description = "Zona das VMs dos nós de clientes (NODES_ZONE do cp-worker e do Job)."
  type        = string
  default     = "southamerica-east1-b"
}

variable "images_project_id" {
  description = "Projeto do registro das imagens do nó (o do nó da Verax, envs/verax). Vazio: nada é concedido lá. Preenchido: cp-terraform pode dar leitura do registro à conta de cada nó, como o envs/homolog-sp faz à mão."
  type        = string
  default     = ""

  validation {
    condition     = var.images_project_id == "" || can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.images_project_id))
    error_message = "ID de projeto da GCP inválido (6 a 30 caracteres, minúsculas, números e hífen)."
  }
}

variable "images_location" {
  description = "Região do registro das imagens do nó."
  type        = string
  default     = "us-east1"
}

variable "images_repository_id" {
  description = "Nome do registro das imagens do nó."
  type        = string
  default     = "verax-control"
}

variable "release_bucket" {
  description = "Bucket de releases do nó (manifesto da versão e bundle do painel, PR-N7). Vazio até existir. Preenchido: cp-worker ganha leitura nele."
  type        = string
  default     = ""
}

variable "firebase_panel_projects" {
  description = "Projetos do pool do Firebase dos painéis dos clientes (um projeto a cada 36 clientes; o primeiro nasce na primeira venda, no plano Spark), na ordem em que o preflight os usa. cp-worker ganha firebasehosting.admin em cada um, e em mais nenhum: nunca este projeto, que hospeda o site do plano de controle (`verax-conta`) e os sites do Painel que já existem. Vazio até a primeira venda."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for project in var.firebase_panel_projects : can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", project))])
    error_message = "Cada item precisa ser um ID de projeto da GCP."
  }

  validation {
    condition     = !contains(var.firebase_panel_projects, var.project_id)
    error_message = "O projeto do plano de controle não entra no pool dos painéis dos clientes: o cp-worker não pode ser firebasehosting.admin do site conta.veraxsistemas.com.br. Crie um projeto só para os painéis."
  }
}

variable "hosting_site_id" {
  description = "ID do site do Firebase Hosting que serve o plano de controle (ids de site são globais no Firebase)."
  type        = string
  default     = "verax-conta"
}

variable "hosting_domain" {
  description = "Domínio próprio do site do plano de controle. Os registros de DNS saem em `terraform output cloudflare_dns_records`."
  type        = string
  default     = "conta.veraxsistemas.com.br"
}

variable "firestore_pitr" {
  description = "Recuperação pontual (PITR) do Firestore. Desligada por padrão: a GCP cobra o armazenamento do PITR à parte, sem nível gratuito e com no mínimo 1 dia cobrado (preços do Firestore, 04/11/2026)."
  type        = bool
  default     = false
}

variable "github_repository" {
  description = "Repositório do GitHub cujo environment pode implantar (dono/nome, como no `sub` do token OIDC do GitHub)."
  type        = string
  default     = "williandotdev/verax-control"
}

variable "github_repository_id" {
  description = "ID numérico do repositório no GitHub. O provedor de identidade só aceita tokens com este ID: o acesso sobrevive a uma troca de nome e não passa a um repositório recriado com o mesmo nome."
  type        = string
  default     = "1441377752"
}

variable "github_repository_owner_id" {
  description = "ID numérico do dono do repositório no GitHub (mesmo motivo do github_repository_id)."
  type        = string
  default     = "92734416"
}

variable "github_environment" {
  description = "Environment do GitHub Actions que implanta o plano de controle. A condição do provedor de identidade (identities.tf) só aceita o token dele vindo de um push ou de um disparo manual na branch main; restrinja o environment à main no GitHub também (deployment branches)."
  type        = string
  default     = "control-plane"
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
  description = "Orçamento mensal do projeto, na moeda da conta de faturamento. Avisos em 50%, 90% e 100%. O plano de controle fica em R$ 0 com 0 clientes e em R$ 2 a 8 com 20 (plano, seção 6)."
  type        = number
  default     = 15
}
