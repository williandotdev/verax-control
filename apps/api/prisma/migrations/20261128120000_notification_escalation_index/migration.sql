-- Contagem dos e-mails ao contato de escalonamento na hora (o limite de 5): a cada aviso crítico, ela lia a tabela de
-- avisos inteira. Só acrescenta um índice (nada muda de formato: a imagem anterior do nó segue funcionando).

-- CreateIndex
CREATE INDEX "Notification_tenantId_escalationDeliveredAt_idx" ON "Notification"("tenantId", "escalationDeliveredAt");
