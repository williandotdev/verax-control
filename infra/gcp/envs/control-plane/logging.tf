# Retenção dos logs do projeto do plano de controle (Marco Civil da Internet, art. 15: os registros de acesso a
# aplicações ficam guardados por 6 meses; a Política de privacidade promete o mesmo). Os registros de acesso do site
# de contratação (`conta`) e do console (`admin`) são os logs de requisição do Cloud Run (`run.googleapis.com/requests`:
# data e hora, IP de origem, endereço e resposta de cada requisição) e os logs dos serviços, e todos caem no bucket
# `_Default` do Cloud Logging, que guarda 30 dias por padrão. Aqui ele passa a guardar `log_retention_days` (180).
#
# O `_Default` é criado pelo Google com o projeto e não pode ser apagado. Pela documentação do provider
# (`google_logging_project_bucket_config`): criar este recurso "adquire e atualiza" o bucket que já existe (nada novo
# nasce, e nada some), e destruí-lo só tira a configuração do estado do Terraform, "deixando o bucket como está" (com o
# prazo que tiver na hora). O `_Required` (auditoria de administração e eventos de sistema, 400 dias, fixo) não muda.
#
# Custo: a GCP cobra o armazenamento dos logs guardados além de 30 dias, por GiB e por mês (preços do Cloud Logging).
# No volume deste projeto (poucos MB por mês), são centavos. O prazo não pode ficar abaixo de 6 meses (a validação da
# variável); mais do que isso guarda dado pessoal (o IP) além do que a lei pede, então mude só com motivo.
resource "google_logging_project_bucket_config" "default" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = var.log_retention_days

  depends_on = [google_project_service.apis]
}
