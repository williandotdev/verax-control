# Projeto GCP de cliente (`customer_projects`): o cliente cria o sink no projeto dele, com o comando de Contas cloud, e
# o nó ganha só o tópico, a assinatura e a publicação para a identidade daquele sink. Nada é criado nem concedido no
# projeto do cliente.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. Os projetos e as identidades são fictícios.

mock_provider "google" {
  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos. Os IDs dos tópicos e
  # das assinaturas ficam com o valor simulado, diferente em cada um: é isso que mostra qual tópico cada um usa.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/projeto-exemplo-nos/serviceAccounts/verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
      email = "verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_logging_project_sink" {
    defaults = {
      writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id         = "projeto-exemplo-nos"
  region             = "southamerica-east1"
  zone               = "southamerica-east1-b"
  name_prefix        = "verax-teste"
  node_profile       = "standard"
  subnet_cidr        = "10.81.0.0/24"
  monitored_projects = ["projeto-monitorado-a"]
  customer_projects = {
    "cliente-demo-a" = { writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
  }
}

run "topico_assinatura_e_publicacao_so_do_sink_do_cliente" {
  # O mesmo nome dos projetos monitorados: é o que o painel mostra no comando do sink e cadastra na conta.
  assert {
    condition = (
      keys(google_pubsub_topic.security_logs) == ["cliente-demo-a", "projeto-monitorado-a"] &&
      google_pubsub_topic.security_logs["cliente-demo-a"].name == "verax-teste-security-cliente-demo-a" &&
      google_pubsub_topic.security_logs["cliente-demo-a"].message_retention_duration == "604800s" &&
      tolist(google_pubsub_topic.security_logs["cliente-demo-a"].message_storage_policy[0].allowed_persistence_regions) == tolist(["southamerica-east1"])
    )
    error_message = "O projeto de cliente não ganhou o tópico com o nome, a retenção e a região dos monitorados."
  }

  assert {
    condition = (
      google_pubsub_subscription.security_logs["cliente-demo-a"].name == "verax-teste-security-cliente-demo-a" &&
      google_pubsub_subscription.security_logs["cliente-demo-a"].topic == google_pubsub_topic.security_logs["cliente-demo-a"].id &&
      google_pubsub_subscription.security_logs["cliente-demo-a"].ack_deadline_seconds == 60 &&
      !google_pubsub_subscription.security_logs["cliente-demo-a"].retain_acked_messages &&
      output.pubsub_subscriptions["cliente-demo-a"] == google_pubsub_subscription.security_logs["cliente-demo-a"].id
    )
    error_message = "A assinatura do projeto de cliente (e a saída que vai para o painel) não é a dos monitorados."
  }

  # Nenhum sink no projeto do cliente: quem o cria é ele.
  assert {
    condition     = keys(google_logging_project_sink.security) == ["projeto-monitorado-a"] && keys(google_pubsub_topic_iam_member.sink_publisher) == ["projeto-monitorado-a"]
    error_message = "O Terraform criou um sink (ou a publicação dele) no projeto do cliente."
  }

  assert {
    condition = (
      keys(google_pubsub_topic_iam_member.customer_sink_publisher) == ["cliente-demo-a"] &&
      google_pubsub_topic_iam_member.customer_sink_publisher["cliente-demo-a"].role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.customer_sink_publisher["cliente-demo-a"].member == "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" &&
      google_pubsub_topic_iam_member.customer_sink_publisher["cliente-demo-a"].topic == google_pubsub_topic.security_logs["cliente-demo-a"].id &&
      google_pubsub_topic_iam_member.customer_sink_publisher["cliente-demo-a"].topic != google_pubsub_topic.security_logs["projeto-monitorado-a"].id
    )
    error_message = "A publicação não é só da identidade do sink do cliente, só no tópico do projeto dele."
  }

  # O nó lê a assinatura do projeto de cliente como lê as outras, e o alerta de fila parada a cobre pelo prefixo.
  assert {
    condition = (
      google_pubsub_subscription_iam_member.node_subscriber["cliente-demo-a"].subscription == google_pubsub_subscription.security_logs["cliente-demo-a"].id &&
      google_pubsub_subscription_iam_member.node_subscriber["cliente-demo-a"].role == "roles/pubsub.subscriber" &&
      google_pubsub_subscription_iam_member.node_subscriber["cliente-demo-a"].member == "serviceAccount:verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com" &&
      strcontains(google_monitoring_alert_policy.stalled_subscription[0].conditions[0].condition_threshold[0].filter, "starts_with(\"verax-teste-security-\")")
    )
    error_message = "O nó não lê a assinatura do projeto de cliente, ou o alerta de fila parada não a cobre."
  }
}

# Só projetos de clientes, sem nenhum monitorado: nenhum sink é criado em lugar nenhum.
run "so_projetos_de_clientes" {
  command = plan

  variables {
    monitored_projects = []
    customer_projects = {
      "cliente-demo-a" = { writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
      "cliente-demo-b" = { writer_identity = "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com" }
    }
  }

  assert {
    condition = (
      keys(google_pubsub_topic.security_logs) == ["cliente-demo-a", "cliente-demo-b"] &&
      keys(google_pubsub_topic_iam_member.customer_sink_publisher) == ["cliente-demo-a", "cliente-demo-b"] &&
      google_pubsub_topic_iam_member.customer_sink_publisher["cliente-demo-b"].member == "serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com" &&
      length(google_logging_project_sink.security) == 0 &&
      length(google_pubsub_topic_iam_member.sink_publisher) == 0
    )
    error_message = "Com só projetos de clientes, cada um ganha o tópico e a publicação da própria identidade, e nenhum sink é criado."
  }
}

# A identidade compartilhada antiga, que serve a sinks de qualquer projeto: com ela, qualquer um publicaria no tópico.
run "recusa_a_identidade_compartilhada_antiga" {
  command = plan

  variables {
    customer_projects = {
      "cliente-demo-a" = { writer_identity = "serviceAccount:cloud-logs@system.gserviceaccount.com" }
    }
  }

  expect_failures = [var.customer_projects]
}

run "recusa_conta_de_servico_comum" {
  command = plan

  variables {
    customer_projects = {
      "cliente-demo-a" = { writer_identity = "serviceAccount:coletor@cliente-demo-a.iam.gserviceaccount.com" }
    }
  }

  expect_failures = [var.customer_projects]
}

# O agente de uma pasta ou organização (sink agregado) publicaria logs de outros projetos no tópico deste.
run "recusa_agente_de_pasta_ou_organizacao" {
  command = plan

  variables {
    customer_projects = {
      "cliente-demo-a" = { writer_identity = "serviceAccount:service-org-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
    }
  }

  expect_failures = [var.customer_projects]
}

run "recusa_pessoa_ou_grupo" {
  command = plan

  variables {
    customer_projects = {
      "cliente-demo-a" = { writer_identity = "group:todos@example.com" }
    }
  }

  expect_failures = [var.customer_projects]
}

# O `member` do IAM exige o tipo; sem ele, o apply falharia no meio.
run "recusa_identidade_sem_o_tipo" {
  command = plan

  variables {
    customer_projects = {
      "cliente-demo-a" = { writer_identity = "service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
    }
  }

  expect_failures = [var.customer_projects]
}

run "recusa_projeto_invalido" {
  command = plan

  variables {
    customer_projects = {
      "123456789012" = { writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
    }
  }

  expect_failures = [var.customer_projects]
}

# A mesma identidade em dois projetos daria ao sink de um a publicação no tópico do outro, e o apply não falharia.
run "recusa_identidade_repetida_em_dois_projetos" {
  command = plan

  variables {
    customer_projects = {
      "cliente-demo-a" = { writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
      "cliente-demo-b" = { writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
    }
  }

  expect_failures = [var.customer_projects]
}

# O mesmo projeto nas duas listas criaria o sink do Terraform e daria a publicação a outra identidade no mesmo tópico.
run "recusa_projeto_monitorado_e_de_cliente" {
  command = plan

  variables {
    customer_projects = {
      "projeto-monitorado-a" = { writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com" }
    }
  }

  expect_failures = [var.customer_projects]
}
