-- A nota `flow_logs_read_together` das fontes (onboarding self-service da AWS): autorizar um flow log da VPC lê todos os
-- flow logs daquela conta e região que gravam no mesmo bucket, porque o módulo aws-s3 do Wazuh lê a pasta da conta e da
-- região, e não um flow log só. Com a nota, o painel avisa antes da autorização. A lista de notas do CHECK da descoberta
-- ganha esse valor: o Postgres não altera um CHECK, então a constraint sai e volta igual, com a nota a mais, na mesma
-- transação.
-- Nenhuma linha muda, e toda linha que valia continua valendo (a lista só cresce).

-- AlterTable
ALTER TABLE "AwsSource" DROP CONSTRAINT "AwsSource_discovery_check";
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_discovery_check" CHECK (
  "availability" IN ('available', 'not_enabled', 'no_destination', 'unsupported_destination', 'unsupported_format')
  AND ("loggingState" IS NULL OR "loggingState" IN ('logging', 'stopped', 'enabled', 'disabled', 'publishing'))
  AND "permission" IN ('granted', 'missing', 'unknown')
  AND ("permissionDetail" IS NULL OR "permissionDetail" ~ '^[A-Za-z0-9_:-]{1,96}$')
  AND jsonb_typeof("details") = 'object'
  AND "notes" <@ ARRAY[
    'aws_cost_guardduty', 'aws_cost_security_hub', 'aws_cost_inspector', 'aws_cost_access_analyzer',
    'aws_cost_new_trail', 'aws_cost_flow_logs', 'aws_cost_waf_logging', 'high_volume', 'tag_required',
    'stack_update_required', 'additional_bucket_required', 'central_bucket', 'covered_by_api', 'covered_by_legacy',
    'recommended', 'not_security_events', 'not_collected_yet', 'flow_logs_read_together'
  ]::text[]
);
