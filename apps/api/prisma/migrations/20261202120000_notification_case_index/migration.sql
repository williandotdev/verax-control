-- Os avisos de um caso (`Notification.caseId`), para os avisos por caso decidirem o que já foi avisado sem ler a tabela de
-- avisos inteira a cada minuto. Só acrescenta um índice: nenhuma coluna, regra ou valor de enum muda, e a imagem anterior do
-- nó segue funcionando. Parcial: o aviso que não é de caso (todos, com os casos desligados) não entra nele, e a gravação
-- dele não fica mais cara. O Prisma não declara índice parcial (e não o compara com o schema).
CREATE INDEX "Notification_caseId_idx" ON "Notification" ("caseId") WHERE "caseId" IS NOT NULL;
