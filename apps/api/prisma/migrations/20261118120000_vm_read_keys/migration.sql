-- Chaves de leitura da VM própria do cliente (NODE_PLATFORM=vm): lá o nó não tem identidade do Google, e a AWS e a GCP
-- são lidas com a chave de uma identidade só de leitura que o admin cola no painel, cifrada no cofre do nó como o token
-- do Cloudflare. Os nós da GCP continuam sem chave: a API recusa os dois tipos novos fora da VM própria.
--
-- 1. O enum do cofre ganha a chave de acesso do usuário IAM (`aws_access_key`, que o PR-V3' tinha tirado) e a chave da
--    conta de serviço da GCP (`gcp_service_account_key`). Só acrescenta: nenhuma linha muda.
ALTER TYPE "CloudCredentialKind" ADD VALUE IF NOT EXISTS 'aws_access_key';
ALTER TYPE "CloudCredentialKind" ADD VALUE IF NOT EXISTS 'gcp_service_account_key';

-- 2. O texto cifrado cresce: a chave da conta de serviço (o PEM da RSA-2048, cerca de 1,7 KB) não cabe nos 318 bytes
--    que o RSA-OAEP cifra de uma vez, e vai num envelope híbrido (a chave AES-256-GCM cifrada com a RSA do nó, depois o
--    texto), ainda no formato `v<versão>:<base64>` do CHECK, que não muda. Aumentar um VARCHAR não reescreve a tabela.
ALTER TABLE "CloudCredential" ALTER COLUMN "ciphertext" TYPE VARCHAR(8192);
