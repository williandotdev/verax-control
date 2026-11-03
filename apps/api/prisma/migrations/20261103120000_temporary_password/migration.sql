-- Senha temporária: a conta nasce com uma senha gerada pelo administrador, que precisa ser trocada no primeiro login.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "temporaryPasswordExpiresAt" TIMESTAMPTZ(3);
