# O que é de um cliente na célula (CE-07): cada permissão só no recurso do cliente (a conta de serviço dele, o cofre dele,
# os tópicos dele), os nomes dos tópicos com o UUID da conta (nunca reaproveitados) e o que as variáveis recusam.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. Projetos, contas e identidades são fictícios.

mock_provider "google" {
  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos. O ID único é fictício.
  mock_resource "google_service_account" {
    defaults = {
      name      = "projects/projeto-exemplo-celula/serviceAccounts/vxt-cliente-demo-a@projeto-exemplo-celula.iam.gserviceaccount.com"
      email     = "vxt-cliente-demo-a@projeto-exemplo-celula.iam.gserviceaccount.com"
      unique_id = "109876543210987654321"
    }
  }

  mock_resource "google_secret_manager_secret" {
    defaults = {
      id = "projects/projeto-exemplo-celula/secrets/vxt-cliente-demo-a-admin-bootstrap"
    }
  }
}

variables {
  project_id                = "projeto-exemplo-celula"
  cell_id                   = "sp1"
  slug                      = "cliente-demo-a"
  cell_node_service_account = "verax-celula@projeto-exemplo-celula.iam.gserviceaccount.com"
  control_plane_sa          = "cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
  gcp_sources = {
    "0190a8c0-0000-7000-8000-00000000000a" = {
      project_id      = "projeto-do-cliente-a1"
      writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com"
    }
    "0190a8c0-0000-7000-8000-00000000000b" = {
      project_id      = "projeto-do-cliente-a2"
      writer_identity = "serviceAccount:service-310987654321@gcp-sa-logging.iam.gserviceaccount.com"
    }
  }
}

run "permissoes_so_nos_recursos_do_cliente" {
  assert {
    condition     = google_service_account.tenant.account_id == "vxt-cliente-demo-a"
    error_message = "A conta do cliente é vxt-<slug>."
  }

  # A VM da célula só emite o token OIDC, e só nesta conta.
  assert {
    condition = (
      google_service_account_iam_member.cell_id_token.service_account_id == google_service_account.tenant.name &&
      google_service_account_iam_member.cell_id_token.role == "roles/iam.serviceAccountOpenIdTokenCreator" &&
      google_service_account_iam_member.cell_id_token.member == "serviceAccount:verax-celula@projeto-exemplo-celula.iam.gserviceaccount.com"
    )
    error_message = "A VM da célula emite o token OIDC só na conta do cliente."
  }

  # O cp-worker só desativa e reativa, e só esta conta.
  assert {
    condition = (
      google_service_account_iam_member.worker_toggle.service_account_id == google_service_account.tenant.name &&
      google_service_account_iam_member.worker_toggle.role == "projects/projeto-exemplo-celula/roles/cpTenantSaToggle_sp1" &&
      google_service_account_iam_member.worker_toggle.member == "serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
    )
    error_message = "O cp-worker suspende só a conta do cliente, com o papel da célula."
  }

  assert {
    condition = (
      google_secret_manager_secret.admin_bootstrap.secret_id == "vxt-cliente-demo-a-admin-bootstrap" &&
      one(one(one(google_secret_manager_secret.admin_bootstrap.replication).user_managed).replicas).location == "southamerica-east1"
    )
    error_message = "O cofre do primeiro acesso é vxt-<slug>-admin-bootstrap, guardado só na região da célula."
  }

  assert {
    condition = (
      google_secret_manager_secret_iam_member.cell_admin_bootstrap.secret_id == google_secret_manager_secret.admin_bootstrap.id &&
      google_secret_manager_secret_iam_member.cell_admin_bootstrap.role == "roles/secretmanager.secretVersionAdder" &&
      google_secret_manager_secret_iam_member.cell_admin_bootstrap.member == "serviceAccount:verax-celula@projeto-exemplo-celula.iam.gserviceaccount.com"
    )
    error_message = "A VM só grava no cofre do primeiro acesso."
  }

  assert {
    condition = (
      toset(keys(google_secret_manager_secret_iam_member.worker_admin_bootstrap)) == toset(["roles/secretmanager.secretAccessor", "roles/secretmanager.secretVersionManager"]) &&
      alltrue([for binding in values(google_secret_manager_secret_iam_member.worker_admin_bootstrap) :
      binding.secret_id == google_secret_manager_secret.admin_bootstrap.id && binding.member == "serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"])
    )
    error_message = "O cp-worker lê e destrói a senha só no cofre do cliente."
  }

  assert {
    condition = (
      output.tenant_service_account_unique_id == "109876543210987654321" &&
      output.admin_bootstrap_secret == "vxt-cliente-demo-a-admin-bootstrap" &&
      toset(keys(output.gcp_sources)) == toset(["0190a8c0-0000-7000-8000-00000000000a", "0190a8c0-0000-7000-8000-00000000000b"])
    )
    error_message = "As saídas não trazem o ID único da conta, o cofre e os tópicos de cada conta."
  }
}

run "topicos_com_o_uuid_da_conta" {
  command = plan

  # O nome leva o UUID da conta cloud, e nunca o projeto: outro cliente que cadastre o mesmo projeto depois ganha outro
  # tópico, e o sink esquecido do cliente antigo não chega a ele.
  assert {
    condition = alltrue([for id, topic in google_pubsub_topic.gcp_source :
    topic.name == "vxc-sp1-gcp-${id}" && google_pubsub_subscription.gcp_source[id].name == topic.name])
    error_message = "O tópico e a assinatura de cada conta são vxc-<célula>-gcp-<UUID da conta>."
  }

  assert {
    condition = alltrue([for topic in values(google_pubsub_topic.gcp_source) :
    !strcontains(topic.name, "projeto-do-cliente")])
    error_message = "O nome do tópico traz o projeto do cliente (reaproveitável depois de uma exclusão)."
  }

  assert {
    condition = alltrue([for id, source in var.gcp_sources :
      google_pubsub_topic_iam_member.sink_publisher[id].member == source.writer_identity &&
      google_pubsub_topic_iam_member.sink_publisher[id].role == "roles/pubsub.publisher" &&
    google_pubsub_subscription_iam_member.cell_subscriber[id].member == "serviceAccount:verax-celula@projeto-exemplo-celula.iam.gserviceaccount.com"])
    error_message = "Só a identidade do sink publica no tópico da conta dela, e só a VM da célula lê."
  }

  assert {
    condition = alltrue([for topic in values(google_pubsub_topic.gcp_source) :
    topic.message_storage_policy[0].allowed_persistence_regions == toset(["southamerica-east1"])])
    error_message = "Os logs do cliente ficam só na região da célula."
  }
}

run "sem_conta_gcp" {
  command = plan

  variables {
    gcp_sources = {}
  }

  assert {
    condition     = length(google_pubsub_topic.gcp_source) == 0 && length(output.gcp_sources) == 0
    error_message = "Sem conta GCP, nenhum tópico."
  }
}

run "subdominio_com_dois_hifens" {
  command = plan

  variables {
    slug = "ab--cliente"
  }

  expect_failures = [var.slug]
}

run "uuid_em_maiusculas" {
  command = plan

  variables {
    gcp_sources = {
      "0190A8C0-0000-7000-8000-00000000000A" = {
        project_id      = "projeto-do-cliente-a1"
        writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com"
      }
    }
  }

  expect_failures = [var.gcp_sources]
}

run "identidade_que_nao_e_do_sink" {
  command = plan

  variables {
    gcp_sources = {
      "0190a8c0-0000-7000-8000-00000000000a" = {
        project_id      = "projeto-do-cliente-a1"
        writer_identity = "serviceAccount:alguem@projeto-do-cliente-a1.iam.gserviceaccount.com"
      }
    }
  }

  expect_failures = [var.gcp_sources]
}

run "identidade_repetida" {
  command = plan

  variables {
    gcp_sources = {
      "0190a8c0-0000-7000-8000-00000000000a" = {
        project_id      = "projeto-do-cliente-a1"
        writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com"
      }
      "0190a8c0-0000-7000-8000-00000000000b" = {
        project_id      = "projeto-do-cliente-a2"
        writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com"
      }
    }
  }

  expect_failures = [var.gcp_sources]
}

run "projeto_repetido" {
  command = plan

  variables {
    gcp_sources = {
      "0190a8c0-0000-7000-8000-00000000000a" = {
        project_id      = "projeto-do-cliente-a1"
        writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com"
      }
      "0190a8c0-0000-7000-8000-00000000000b" = {
        project_id      = "projeto-do-cliente-a1"
        writer_identity = "serviceAccount:service-310987654321@gcp-sa-logging.iam.gserviceaccount.com"
      }
    }
  }

  expect_failures = [var.gcp_sources]
}

run "conta_da_vm_de_outro_projeto" {
  command = plan

  variables {
    cell_node_service_account = "verax-celula@outro-projeto-123.iam.gserviceaccount.com"
  }

  expect_failures = [var.cell_node_service_account]
}

run "outra_conta_no_lugar_do_cp_worker" {
  command = plan

  variables {
    control_plane_sa = "cp-terraform@projeto-exemplo-cp.iam.gserviceaccount.com"
  }

  expect_failures = [var.control_plane_sa]
}
