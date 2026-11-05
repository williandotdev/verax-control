# O que o ambiente do cliente recusa antes de criar qualquer coisa. O executor Terraform confere as mesmas variáveis por
# regex antes do `init` (CP-07); esta é a segunda conferência, e o que passa no checkout (o slug, o e-mail do admin, o
# nome da empresa) nunca pode ser recusado aqui, senão o provisionamento falharia depois da compra.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. Todos os valores são fictícios.

mock_provider "google" {}

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

# O que o checkout aceita passa: slug de 3 e de 16 caracteres, e-mail com `+` e apóstrofo, nome com acento, `&` e
# aspas, a /24 mais alta e o plano enterprise com os quatro limites nas pontas das faixas.
run "aceita_o_que_o_checkout_aceita" {
  command = plan

  variables {
    slug                    = "abc"
    bootstrap_admin_email   = "o'neil+ti@cliente-demo-a.example.com"
    bootstrap_tenant_name   = "Ação & \"Filhos\" Comércio Ltda."
    subnet_cidr             = "10.255.255.0/24"
    plan                    = "enterprise"
    plan_max_cloud_accounts = "1"
    plan_max_users          = "1000"
    plan_monthly_gib        = "100000"
    plan_history_days       = "30"
  }

  assert {
    condition     = output.name_prefix == "vx-abc"
    error_message = "Um slug de 3 caracteres foi recusado."
  }
}

run "aceita_slug_de_16" {
  command = plan

  variables {
    slug = "abcdefghij-12345"
  }

  assert {
    condition     = output.name_prefix == "vx-abcdefghij-12345"
    error_message = "Um slug de 16 caracteres foi recusado (vx-<slug> tem 19, o máximo do módulo)."
  }
}

run "recusa_slug_com_maiuscula" {
  command = plan

  variables {
    slug = "Demo-a"
  }

  expect_failures = [var.slug]
}

run "recusa_slug_longo" {
  command = plan

  variables {
    slug = "abcdefghij-123456"
  }

  expect_failures = [var.slug]
}

run "recusa_slug_curto" {
  command = plan

  variables {
    slug = "ab"
  }

  expect_failures = [var.slug]
}

# Hífen nas posições 3 e 4 juntas (o `xn--` do DNS): o painel não abre esse endereço.
run "recusa_slug_com_hifen_reservado" {
  command = plan

  variables {
    slug = "ab--cd"
  }

  expect_failures = [var.slug]
}

run "recusa_slug_terminado_em_hifen" {
  command = plan

  variables {
    slug = "demo-"
  }

  expect_failures = [var.slug]
}

run "recusa_plano_interno" {
  command = plan

  variables {
    plan = "interno"
  }

  expect_failures = [var.plan]
}

run "recusa_enterprise_sem_os_quatro_limites" {
  command = plan

  variables {
    plan                    = "enterprise"
    plan_max_cloud_accounts = "15"
    plan_max_users          = "15"
    plan_monthly_gib        = "60"
  }

  expect_failures = [var.plan]
}

run "recusa_historico_abaixo_de_30_dias" {
  command = plan

  variables {
    plan_history_days = "29"
  }

  expect_failures = [var.plan_history_days]
}

run "recusa_limite_fracionado" {
  command = plan

  variables {
    plan_monthly_gib = "10.5"
  }

  expect_failures = [var.plan_monthly_gib]
}

run "recusa_limite_acima_da_faixa" {
  command = plan

  variables {
    plan_max_users = "1001"
  }

  expect_failures = [var.plan_max_users]
}

run "recusa_limite_zero" {
  command = plan

  variables {
    plan_max_cloud_accounts = "0"
  }

  expect_failures = [var.plan_max_cloud_accounts]
}

run "recusa_versao_fora_do_formato" {
  command = plan

  variables {
    node_version = "v1.2.3"
  }

  expect_failures = [var.node_version]
}

run "recusa_sha256_curto_ou_maiusculo" {
  command = plan

  variables {
    node_package_sha256 = "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.node_package_sha256]
}

run "recusa_origem_sem_https" {
  command = plan

  variables {
    web_origin = "http://demo-a.control.example.com"
  }

  expect_failures = [var.web_origin]
}

run "recusa_origem_com_caminho" {
  command = plan

  variables {
    api_origin = "https://api-demo-a.example.com/v1"
  }

  expect_failures = [var.api_origin]
}

run "recusa_origem_com_barra_no_fim" {
  command = plan

  variables {
    web_origin = "https://demo-a.control.example.com/"
  }

  expect_failures = [var.web_origin]
}

run "recusa_painel_e_api_no_mesmo_endereco" {
  command = plan

  variables {
    api_origin = "https://demo-a.control.example.com"
  }

  expect_failures = [var.api_origin]
}

run "recusa_remetente_com_nome" {
  command = plan

  variables {
    mail_from = "Verax <nao-responda@example.com>"
  }

  expect_failures = [var.mail_from]
}

run "recusa_email_com_dois_pontos_seguidos" {
  command = plan

  variables {
    bootstrap_admin_email = "admin..ti@cliente-demo-a.example.com"
  }

  expect_failures = [var.bootstrap_admin_email]
}

run "recusa_email_sem_dominio" {
  command = plan

  variables {
    bootstrap_admin_email = "admin@localhost"
  }

  expect_failures = [var.bootstrap_admin_email]
}

run "recusa_email_de_suporte_invalido" {
  command = plan

  variables {
    bootstrap_support_email = "suporte@"
  }

  expect_failures = [var.bootstrap_support_email]
}

# A conta de suporte é da Verax: nunca o mesmo e-mail do primeiro admin do cliente.
run "recusa_suporte_com_o_email_do_admin" {
  command = plan

  variables {
    bootstrap_support_email = "Admin@Cliente-Demo-A.example.com"
  }

  expect_failures = [var.bootstrap_support_email]
}

run "recusa_limite_que_nao_e_numero" {
  command = plan

  variables {
    plan_max_users = "quinze"
  }

  expect_failures = [var.plan_max_users]
}

# Uma quebra de linha viraria outra linha (outra variável) no node.conf.
run "recusa_nome_com_quebra_de_linha" {
  command = plan

  variables {
    bootstrap_tenant_name = "Cliente Demo A\nPLAN=interno"
  }

  expect_failures = [var.bootstrap_tenant_name]
}

run "recusa_nome_com_espaco_nas_pontas" {
  command = plan

  variables {
    bootstrap_tenant_name = " Cliente Demo A"
  }

  expect_failures = [var.bootstrap_tenant_name]
}

run "recusa_nome_de_201_caracteres" {
  command = plan

  variables {
    bootstrap_tenant_name = join("", [for index in range(201) : "a"])
  }

  expect_failures = [var.bootstrap_tenant_name]
}

run "recusa_faixa_fora_de_10_8" {
  command = plan

  variables {
    subnet_cidr = "192.168.1.0/24"
  }

  expect_failures = [var.subnet_cidr]
}

run "recusa_faixa_maior_que_24" {
  command = plan

  variables {
    subnet_cidr = "10.1.0.0/16"
  }

  expect_failures = [var.subnet_cidr]
}

run "recusa_faixa_fora_do_endereco_da_rede" {
  command = plan

  variables {
    subnet_cidr = "10.1.0.5/24"
  }

  expect_failures = [var.subnet_cidr]
}

run "recusa_octeto_invalido" {
  command = plan

  variables {
    subnet_cidr = "10.256.0.0/24"
  }

  expect_failures = [var.subnet_cidr]
}

# A senha do admin só para o cp-worker: o cp-public e o cp-terraform nunca recebem as permissões dos cofres.
run "recusa_outra_conta_do_plano_de_controle" {
  command = plan

  variables {
    control_plane_sa = "cp-terraform@projeto-exemplo-cp.iam.gserviceaccount.com"
  }

  expect_failures = [var.control_plane_sa]
}

run "recusa_conta_sem_o_dominio_de_conta_de_servico" {
  command = plan

  variables {
    control_plane_sa = "cp-worker@example.com"
  }

  expect_failures = [var.control_plane_sa]
}

run "recusa_zona_fora_da_regiao" {
  command = plan

  variables {
    zone = "us-east1-b"
  }

  expect_failures = [var.zone]
}

# O registro das imagens: só o GHCR ou o Artifact Registry, nos formatos que a instalação sem operador aceita.
run "recusa_registro_de_outro_lugar" {
  command = plan

  variables {
    images_repository = "docker.io/williandotdev/verax-control"
  }

  expect_failures = [var.images_repository]
}

run "recusa_registro_com_caminho_a_mais" {
  command = plan

  variables {
    images_repository = "ghcr.io/williandotdev/verax-control/api"
  }

  expect_failures = [var.images_repository]
}

run "recusa_artifact_registry_sem_projeto_valido" {
  command = plan

  variables {
    images_repository = "us-east1-docker.pkg.dev/Projeto/verax-control"
  }

  expect_failures = [var.images_repository]
}

# O e-mail do nó: as três juntas ou nenhuma, nos formatos que a instalação sem operador escreve no node.conf.
run "aceita_o_e_mail_do_no" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example"
    smtp_port = "65535"
    smtp_user = "avisos+nos_1@verax.example"
  }

  assert {
    condition     = module.node.install_metadata["verax-smtp-port"] == "65535"
    error_message = "O e-mail do nó, nos formatos aceitos, foi recusado."
  }
}

run "recusa_e_mail_do_no_pela_metade" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example"
    smtp_port = "465"
  }

  expect_failures = [var.smtp_host]
}

run "recusa_usuario_sem_servidor" {
  command = plan

  variables {
    smtp_port = "465"
    smtp_user = "avisos@verax.example"
  }

  expect_failures = [var.smtp_host]
}

run "recusa_servidor_com_maiuscula" {
  command = plan

  variables {
    smtp_host = "SMTP.caixa-exemplo.example"
    smtp_port = "465"
    smtp_user = "avisos@verax.example"
  }

  expect_failures = [var.smtp_host]
}

run "recusa_servidor_com_porta" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example:465"
    smtp_port = "465"
    smtp_user = "avisos@verax.example"
  }

  expect_failures = [var.smtp_host]
}

run "recusa_servidor_com_comando" {
  command = plan

  variables {
    smtp_host = "smtp.example;touch pwned"
    smtp_port = "465"
    smtp_user = "avisos@verax.example"
  }

  expect_failures = [var.smtp_host]
}

run "recusa_servidor_sem_dominio" {
  command = plan

  variables {
    smtp_host = "localhost"
    smtp_port = "465"
    smtp_user = "avisos@verax.example"
  }

  expect_failures = [var.smtp_host]
}

run "recusa_porta_zero" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example"
    smtp_port = "0"
    smtp_user = "avisos@verax.example"
  }

  expect_failures = [var.smtp_port]
}

run "recusa_porta_acima_de_65535" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example"
    smtp_port = "65536"
    smtp_user = "avisos@verax.example"
  }

  expect_failures = [var.smtp_port]
}

run "recusa_porta_que_nao_e_numero" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example"
    smtp_port = "465 "
    smtp_user = "avisos@verax.example"
  }

  expect_failures = [var.smtp_port]
}

run "recusa_usuario_com_apostrofo" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example"
    smtp_port = "465"
    smtp_user = "o'neil@verax.example"
  }

  expect_failures = [var.smtp_user]
}

run "recusa_usuario_com_espaco" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example"
    smtp_port = "465"
    smtp_user = "avisos verax"
  }

  expect_failures = [var.smtp_user]
}

run "recusa_usuario_que_comeca_com_hifen" {
  command = plan

  variables {
    smtp_host = "smtp.caixa-exemplo.example"
    smtp_port = "465"
    smtp_user = "-avisos"
  }

  expect_failures = [var.smtp_user]
}
