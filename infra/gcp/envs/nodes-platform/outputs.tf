output "tfstate_bucket" {
  description = "Bucket do estado do projeto dos nós: TFSTATE_BUCKET do plano de controle e o `-backend-config=bucket=` do envs/tenant e da homologação."
  value       = google_storage_bucket.tfstate.name
}

output "control_plane_roles" {
  description = "Papéis personalizados do plano de controle neste projeto (o id completo, `projects/<projeto>/roles/<nome>`). Nulo sem control_plane_project_id."
  value = local.control_plane_enabled ? {
    cpSecretsProvisioner     = google_project_iam_custom_role.secrets_provisioner[0].id
    cpBucketsProvisioner     = google_project_iam_custom_role.buckets_provisioner[0].id
    cpNodeLifecycle          = google_project_iam_custom_role.node_lifecycle[0].id
    cpSecretVersionDestroyer = google_project_iam_custom_role.secret_version_destroyer[0].id
  } : null
}
