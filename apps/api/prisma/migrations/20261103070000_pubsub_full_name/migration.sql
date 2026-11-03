-- A assinatura do Pub/Sub passa a ser guardada pelo nome completo (projects/<projeto>/subscriptions/<id>): o ID só
-- é único dentro do projeto dono, e dois clientes podem usar o mesmo ID em projetos diferentes.
ALTER TABLE "CloudAccount" ALTER COLUMN "pubsubSubscription" SET DATA TYPE VARCHAR(320);
