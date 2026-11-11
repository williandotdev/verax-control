# O que a célula tem além do nó (CE-03, cell.tf): o canal com o plano de controle (só com o projeto do plano de controle
# e o endereço do cp-worker), o bucket das exportações e os backups de 85 dias.
#
# - Comandos: só o cp-worker publica; só a VM da célula lê, com ordem por chave.
# - Relatórios: só a VM da célula publica; a assinatura push entrega ao cp-worker, na rota da célula, com o token OIDC de
#   uma conta só para isso, emitido pelo agente do Pub/Sub e por mais ninguém.
# - Exportações: ciclo de vida de 31 dias; a VM só cria, e só na pasta da célula.
# - Sem o plano de controle, nada do canal existe (a célula como antes).
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. Projetos, contas e endereços são fictícios.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
}

# A conta da VM e a do push com e-mails próprios (o simulado daria o mesmo texto às duas).
override_resource {
  target = module.node.google_service_account.node
  values = {
    name      = "projects/projeto-exemplo-nos/serviceAccounts/verax-celula@projeto-exemplo-nos.iam.gserviceaccount.com"
    email     = "verax-celula@projeto-exemplo-nos.iam.gserviceaccount.com"
    unique_id = "123456789012345678901"
  }
}

override_resource {
  target = google_service_account.reports_push
  values = {
    name  = "projects/projeto-exemplo-nos/serviceAccounts/vxc-sp1-push@projeto-exemplo-nos.iam.gserviceaccount.com"
    email = "vxc-sp1-push@projeto-exemplo-nos.iam.gserviceaccount.com"
  }
}

variables {
  project_id               = "projeto-exemplo-nos"
  images_project_id        = "projeto-exemplo-imagens"
  control_plane_project_id = "projeto-exemplo-cp"
  control_plane_worker_url = "https://cp-worker-exemplo-rj.a.run.app"
}

run "comandos_so_do_cp_worker" {
  assert {
    condition     = google_pubsub_topic.commands[0].name == "vxc-sp1-commands" && google_pubsub_subscription.commands[0].name == "vxc-sp1-commands"
    error_message = "O tópico e a assinatura dos comandos são vxc-<célula>-commands."
  }

  assert {
    condition = (
      length(google_pubsub_topic_iam_member.commands_publisher) == 1 &&
      google_pubsub_topic_iam_member.commands_publisher[0].topic == google_pubsub_topic.commands[0].id &&
      google_pubsub_topic_iam_member.commands_publisher[0].role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.commands_publisher[0].member == "serviceAccount:cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
    )
    error_message = "Só o cp-worker publica comandos."
  }

  # Nenhuma outra permissão deste ambiente no tópico dos comandos (a VM nunca publica comando).
  assert {
    condition     = google_pubsub_topic_iam_member.reports_publisher[0].topic != google_pubsub_topic.commands[0].id
    error_message = "A VM da célula ganhou publicação no tópico dos comandos."
  }

  assert {
    condition = (
      google_pubsub_subscription_iam_member.commands_subscriber[0].subscription == google_pubsub_subscription.commands[0].id &&
      google_pubsub_subscription_iam_member.commands_subscriber[0].role == "roles/pubsub.subscriber" &&
      google_pubsub_subscription_iam_member.commands_subscriber[0].member == "serviceAccount:verax-celula@projeto-exemplo-nos.iam.gserviceaccount.com"
    )
    error_message = "Só a VM da célula lê a assinatura dos comandos."
  }

  assert {
    condition     = google_pubsub_subscription.commands[0].enable_message_ordering && google_pubsub_subscription.commands[0].expiration_policy[0].ttl == ""
    error_message = "Os comandos de um cliente chegam em ordem, e a assinatura nunca expira."
  }

  assert {
    condition = (
      google_pubsub_topic.commands[0].message_storage_policy[0].allowed_persistence_regions == toset(["southamerica-east1"]) &&
      google_pubsub_topic.commands[0].message_retention_duration == "604800s"
    )
    error_message = "Os comandos ficam só na região da célula, por até 7 dias."
  }
}

run "relatorios_so_da_celula" {
  assert {
    condition = (
      length(google_pubsub_topic_iam_member.reports_publisher) == 1 &&
      google_pubsub_topic_iam_member.reports_publisher[0].topic == google_pubsub_topic.reports[0].id &&
      google_pubsub_topic_iam_member.reports_publisher[0].role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.reports_publisher[0].member == "serviceAccount:verax-celula@projeto-exemplo-nos.iam.gserviceaccount.com"
    )
    error_message = "Só a VM da célula publica relatórios."
  }

  assert {
    condition     = google_pubsub_topic_iam_member.commands_publisher[0].topic != google_pubsub_topic.reports[0].id
    error_message = "O cp-worker ganhou publicação no tópico dos relatórios."
  }

  assert {
    condition = (
      google_pubsub_subscription.reports_push[0].topic == google_pubsub_topic.reports[0].id &&
      google_pubsub_subscription.reports_push[0].push_config[0].push_endpoint == "https://cp-worker-exemplo-rj.a.run.app/internal/cells/sp1/reports" &&
      google_pubsub_subscription.reports_push[0].push_config[0].oidc_token[0].service_account_email == "vxc-sp1-push@projeto-exemplo-nos.iam.gserviceaccount.com" &&
      google_pubsub_subscription.reports_push[0].push_config[0].oidc_token[0].audience == "https://cp-worker-exemplo-rj.a.run.app"
    )
    error_message = "O push entrega na rota da célula no cp-worker, com o token da conta do push e a audiência do serviço."
  }

  # Quem emite o token da conta do push: só o agente do Pub/Sub do projeto, e só nela.
  assert {
    condition = (
      google_service_account_iam_member.reports_push_token[0].service_account_id == google_service_account.reports_push[0].name &&
      google_service_account_iam_member.reports_push_token[0].role == "roles/iam.serviceAccountTokenCreator" &&
      google_service_account_iam_member.reports_push_token[0].member == "serviceAccount:service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com"
    )
    error_message = "O token da conta do push é emitido só pelo agente do Pub/Sub, só nela."
  }

  assert {
    condition = (
      output.cell.commands_subscription == google_pubsub_subscription.commands[0].id &&
      output.cell.reports_topic == google_pubsub_topic.reports[0].id &&
      output.cell.reports_push_service_account == "vxc-sp1-push@projeto-exemplo-nos.iam.gserviceaccount.com" &&
      output.cell.node_service_account == "verax-celula@projeto-exemplo-nos.iam.gserviceaccount.com" &&
      output.cell.id == "sp1"
    )
    error_message = "A saída cell não traz o que o plano de controle precisa."
  }
}

run "exportacoes_e_backups" {
  command = plan

  assert {
    condition = (
      google_storage_bucket.exports.name == "projeto-exemplo-nos-vxc-sp1-exports" &&
      one(google_storage_bucket.exports.lifecycle_rule[0].condition).age == 31 &&
      one(google_storage_bucket.exports.lifecycle_rule[0].action).type == "Delete" &&
      length(google_storage_bucket.exports.lifecycle_rule) == 1 &&
      length(google_storage_bucket.exports.versioning) == 0 &&
      google_storage_bucket.exports.public_access_prevention == "enforced" &&
      google_storage_bucket.exports.uniform_bucket_level_access
    )
    error_message = "As exportações saem com 31 dias, sem versão anterior guardada e sem acesso público."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.cell_exports.role == "roles/storage.objectCreator" &&
      google_storage_bucket_iam_member.cell_exports.member == "serviceAccount:verax-celula@projeto-exemplo-nos.iam.gserviceaccount.com" &&
      google_storage_bucket_iam_member.cell_exports.condition[0].expression == "resource.name.startsWith(\"projects/_/buckets/projeto-exemplo-nos-vxc-sp1-exports/objects/sp1/\")"
    )
    error_message = "A VM só cria exportações, e só na pasta da célula."
  }

  # O módulo transforma o valor na idade do ciclo de vida (modules/node/tests/retencao_dos_backups.tftest.hcl).
  assert {
    condition     = output.cell.backup_retention_days == 85
    error_message = "Os backups da célula saem com 85 dias."
  }
}

# Sem o plano de controle: nada do canal; o bucket das exportações e os backups de 85 dias continuam.
run "sem_o_plano_de_controle" {
  command = plan

  variables {
    control_plane_project_id = ""
    control_plane_worker_url = ""
  }

  assert {
    condition = (
      length(google_pubsub_topic.commands) == 0 && length(google_pubsub_topic.reports) == 0 &&
      length(google_pubsub_subscription.commands) == 0 && length(google_pubsub_subscription.reports_push) == 0 &&
      length(google_service_account.reports_push) == 0 && length(google_pubsub_topic_iam_member.commands_publisher) == 0 &&
      length(google_pubsub_topic_iam_member.reports_publisher) == 0
    )
    error_message = "Sem o plano de controle, nenhum recurso do canal."
  }

  assert {
    condition     = output.cell.commands_topic == null && output.cell.reports_push_service_account == null
    error_message = "Sem o plano de controle, a saída cell não traz nome do canal."
  }
}

run "canal_pela_metade" {
  command = plan

  variables {
    control_plane_worker_url = ""
  }

  expect_failures = [var.control_plane_worker_url]
}

run "endereco_com_caminho" {
  command = plan

  variables {
    control_plane_worker_url = "https://cp-worker-exemplo-rj.a.run.app/internal"
  }

  expect_failures = [var.control_plane_worker_url]
}

run "endereco_http" {
  command = plan

  variables {
    control_plane_worker_url = "http://cp-worker-exemplo-rj.a.run.app"
  }

  expect_failures = [var.control_plane_worker_url]
}

run "backups_acima_de_85" {
  command = plan

  variables {
    backup_retention_days = 90
  }

  expect_failures = [var.backup_retention_days]
}

run "celula_fora_do_formato" {
  command = plan

  variables {
    cell_id = "SP-1"
  }

  expect_failures = [var.cell_id]
}
