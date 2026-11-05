# O nó de um cliente como o executor Terraform do plano de controle o aplica (CP-06): o módulo no perfil standard com
# o prefixo `vx-<slug>`, os três interruptores do CP-06 ligados (o cofre da conta de suporte, os atributos de convidado
# e a configuração nos metadados), as permissões do cp-worker exatamente nos cofres que o plano de controle usa, e as
# saídas que vão para o `outputs.json`. Daqui só se veem as saídas do módulo; os nomes de cada recurso dentro dele e as
# permissões de cada cofre estão em modules/node/tests/tenant.tftest.hcl.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. Projetos, cliente, e-mails, IP e ID são
# fictícios.

mock_provider "google" {
  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_service_account" {
    defaults = {
      name      = "projects/projeto-exemplo-nos/serviceAccounts/vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"
      email     = "vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"
      unique_id = "123456789012345678901"
    }
  }

  mock_resource "google_compute_address" {
    defaults = {
      address = "203.0.113.30"
    }
  }
}

variables {
  project_id              = "projeto-exemplo-nos"
  slug                    = "demo-a"
  plan                    = "profissional"
  node_version            = "node-v1.2.3"
  node_package_sha256     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  web_origin              = "https://demo-a.control.example.com"
  api_origin              = "https://api-demo-a.example.com"
  mail_from               = "nao-responda@example.com"
  subnet_cidr             = "10.1.0.0/24"
  bootstrap_admin_email   = "admin@cliente-demo-a.example.com"
  bootstrap_tenant_name   = "Cliente Demo A"
  bootstrap_support_email = "suporte@example.com"
  control_plane_sa        = "cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
}

run "nasce_o_no_do_cliente" {
  assert {
    condition = (
      output.name_prefix == "vx-demo-a" && output.instance_name == "vx-demo-a" &&
      output.zone == "southamerica-east1-b" && output.nat_ip == "203.0.113.30" &&
      output.service_account_email == "vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com" &&
      output.service_account_unique_id == "123456789012345678901" &&
      output.backups_bucket == "projeto-exemplo-nos-vx-demo-a-backups"
    )
    error_message = "As saídas do nó do cliente (nome, zona, IP de saída, conta e bucket) não são as do prefixo vx-<slug>."
  }

  # Os cinco cofres, todos `vx-<slug>-*`: os dois de fora e os três que a VM grava, com o da conta de suporte.
  assert {
    condition = output.secrets == tomap({
      "admin-bootstrap"         = "vx-demo-a-admin-bootstrap"
      "cloudflare-tunnel-token" = "vx-demo-a-cloudflare-tunnel-token"
      "credentials-key"         = "vx-demo-a-credentials-key"
      "smtp-password"           = "vx-demo-a-smtp-password"
      "support-bootstrap"       = "vx-demo-a-support-bootstrap"
    })
    error_message = "Os cofres do nó do cliente não são os cinco vx-<slug>-*, com o support-bootstrap."
  }

  # Os contratos 2 e 3 com o PR-N7 e o CP-10: atributos de convidado ligados e cada variável na chave `verax-*` dela.
  assert {
    condition = module.node.install_metadata == tomap({
      enable-guest-attributes       = "TRUE"
      verax-config-version          = "1"
      verax-node-profile            = "standard"
      verax-secret-prefix           = "vx-demo-a"
      verax-credentials-vault       = "true"
      verax-backup-bucket           = "projeto-exemplo-nos-vx-demo-a-backups"
      verax-node-sa-unique-id       = "123456789012345678901"
      verax-images-repository       = "ghcr.io/williandotdev/verax-control"
      verax-node-version            = "node-v1.2.3"
      verax-node-package-sha256     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      verax-plan                    = "profissional"
      verax-plan-max-cloud-accounts = ""
      verax-plan-max-users          = ""
      verax-plan-monthly-gib        = ""
      verax-plan-history-days       = ""
      verax-web-origin              = "https://demo-a.control.example.com"
      verax-api-origin              = "https://api-demo-a.example.com"
      verax-mail-from               = "nao-responda@example.com"
      verax-tenant-name             = "Cliente Demo A"
      verax-admin-email             = "admin@cliente-demo-a.example.com"
      verax-support-email           = "suporte@example.com"
    })
    error_message = "As variáveis do cliente não chegaram às chaves verax-* dos metadados, ou os atributos de convidado estão desligados."
  }

  # Nenhuma saída leva os e-mails (do admin e da conta de suporte) nem o nome do cliente: o `outputs.json` fica sem
  # dado pessoal.
  assert {
    condition = alltrue([
      for value in concat(values(output.secrets), [output.name_prefix, output.instance_name, output.zone, output.backups_bucket, output.service_account_email]) :
      !strcontains(value, "admin@cliente-demo-a.example.com") && !strcontains(value, "suporte@example.com") && !strcontains(value, "Cliente Demo A")
    ])
    error_message = "Uma saída do tenant leva o e-mail do admin ou o nome do cliente."
  }
}

# As permissões do cp-worker, uma a uma: exatamente estas quatro, cada uma num cofre só, e nenhuma no projeto.
run "permissoes_do_cp_worker" {
  assert {
    condition = toset(concat(
      [for member in google_secret_manager_secret_iam_member.worker_admin_bootstrap : "${member.secret_id} ${member.role} ${member.member}"],
      ["${google_secret_manager_secret_iam_member.worker_tunnel_token.secret_id} ${google_secret_manager_secret_iam_member.worker_tunnel_token.role} ${google_secret_manager_secret_iam_member.worker_tunnel_token.member}"],
      ["${google_secret_manager_secret_iam_member.worker_credentials_key.secret_id} ${google_secret_manager_secret_iam_member.worker_credentials_key.role} ${google_secret_manager_secret_iam_member.worker_credentials_key.member}"],
      )) == toset([
      "vx-demo-a-admin-bootstrap roles/secretmanager.secretAccessor serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com",
      "vx-demo-a-admin-bootstrap roles/secretmanager.secretVersionManager serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com",
      "vx-demo-a-cloudflare-tunnel-token roles/secretmanager.secretVersionAdder serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com",
      "vx-demo-a-credentials-key projects/projeto-exemplo-nos/roles/cpSecretVersionDestroyer serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com",
    ])
    error_message = "As permissões do cp-worker nos cofres do nó mudaram: são só ler e destruir a senha do admin, gravar o token do túnel e destruir as versões da chave do cofre."
  }

  assert {
    condition = alltrue([
      for member in concat(
        values(google_secret_manager_secret_iam_member.worker_admin_bootstrap),
        [google_secret_manager_secret_iam_member.worker_tunnel_token, google_secret_manager_secret_iam_member.worker_credentials_key],
      ) : member.project == "projeto-exemplo-nos"
    ])
    error_message = "Uma permissão do cp-worker está fora do projeto dos nós."
  }

  # O cofre da conta de suporte e o do SMTP ficam fora do alcance do cp-worker; ler, só o admin-bootstrap.
  assert {
    condition = alltrue([
      for member in concat(
        values(google_secret_manager_secret_iam_member.worker_admin_bootstrap),
        [google_secret_manager_secret_iam_member.worker_tunnel_token, google_secret_manager_secret_iam_member.worker_credentials_key],
      ) :
      !contains([output.secrets["support-bootstrap"], output.secrets["smtp-password"]], member.secret_id) &&
      (member.role != "roles/secretmanager.secretAccessor" || member.secret_id == output.secrets["admin-bootstrap"])
    ])
    error_message = "O cp-worker ganhou acesso ao support-bootstrap ou ao smtp-password, ou lê algum cofre além do admin-bootstrap."
  }

  # A chave do cofre de credenciais: só listar e destruir, nunca ler, gravar ou reativar.
  assert {
    condition     = !contains(["roles/secretmanager.secretAccessor", "roles/secretmanager.secretVersionManager", "roles/secretmanager.secretVersionAdder", "roles/secretmanager.admin"], google_secret_manager_secret_iam_member.worker_credentials_key.role)
    error_message = "O cp-worker ganhou leitura, gravação ou reativação na chave do cofre de credenciais."
  }

  # O papel personalizado é o do envs/nodes-platform, pelo mesmo nome.
  assert {
    condition     = strcontains(file("${path.module}/../nodes-platform/control_plane.tf"), "role_id     = \"cpSecretVersionDestroyer\"")
    error_message = "O envs/nodes-platform não define mais o papel cpSecretVersionDestroyer que o tenant concede no credentials-key."
  }
}

# O registro das imagens (decisão do CP-07): por padrão o GHCR público, que não pede permissão nenhuma; com o Artifact
# Registry do projeto da Verax, a conta da VM ganha só leitura nele, e nada mais.
run "imagens_do_ghcr_por_padrao" {
  assert {
    condition     = length(google_artifact_registry_repository_iam_member.node_reader) == 0
    error_message = "Com o GHCR (o padrão), o tenant não deveria conceder leitura em registro nenhum."
  }
}

run "leitura_do_artifact_registry_quando_e_ele" {
  variables {
    images_repository = "us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control"
  }

  assert {
    condition = (
      length(google_artifact_registry_repository_iam_member.node_reader) == 1 &&
      google_artifact_registry_repository_iam_member.node_reader[0].project == "projeto-exemplo-imagens" &&
      google_artifact_registry_repository_iam_member.node_reader[0].location == "us-east1" &&
      google_artifact_registry_repository_iam_member.node_reader[0].repository == "verax-control" &&
      google_artifact_registry_repository_iam_member.node_reader[0].role == "roles/artifactregistry.reader" &&
      google_artifact_registry_repository_iam_member.node_reader[0].member == "serviceAccount:vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"
    )
    error_message = "A conta da VM do cliente não lê só o registro das imagens do nó."
  }

  assert {
    condition     = module.node.install_metadata["verax-images-repository"] == "us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control"
    error_message = "O registro escolhido não chegou aos metadados da VM."
  }
}

# A vida do nó: versão nova, troca de plano com os limites, o nome do cliente corrigido e a proteção desligada antes
# da exclusão. Nada disso recria a conta de serviço (o ID único, que a AWS do cliente aceita, seria outro).
run "mudancas_de_rotina_nao_recriam_a_conta" {
  command = plan

  variables {
    plan                    = "enterprise"
    plan_max_cloud_accounts = "15"
    plan_max_users          = "20"
    plan_monthly_gib        = "60"
    plan_history_days       = "365"
    node_version            = "node-v1.3.0"
    node_package_sha256     = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
    bootstrap_tenant_name   = "Cliente Demo A Ltda."
    deletion_protection     = false
  }

  assert {
    condition     = output.service_account_unique_id == "123456789012345678901" && output.service_account_email == "vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"
    error_message = "Uma mudança de rotina recriaria a conta de serviço do nó do cliente."
  }

  assert {
    condition = (
      module.node.install_metadata["verax-plan"] == "enterprise" &&
      module.node.install_metadata["verax-plan-max-cloud-accounts"] == "15" &&
      module.node.install_metadata["verax-plan-max-users"] == "20" &&
      module.node.install_metadata["verax-plan-monthly-gib"] == "60" &&
      module.node.install_metadata["verax-plan-history-days"] == "365" &&
      module.node.install_metadata["verax-node-version"] == "node-v1.3.0"
    )
    error_message = "A troca de plano ou de versão não chegou aos metadados da VM."
  }
}
