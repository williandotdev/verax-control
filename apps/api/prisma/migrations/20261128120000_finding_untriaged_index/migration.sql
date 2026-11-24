-- Alertas altos e críticos ainda em "novo" por cliente: a Torre conta a cada minuto em toda tela aberta, e a contagem lia
-- a tabela de achados inteira. Só acrescenta um índice (nada muda de formato: a imagem anterior do nó segue funcionando).

-- CreateIndex
CREATE INDEX "Finding_tenantId_status_severity_idx" ON "Finding"("tenantId", "status", "severity");
