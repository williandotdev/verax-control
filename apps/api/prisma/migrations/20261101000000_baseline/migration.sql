-- Linha de base do banco: menor privilégio antes do primeiro modelo.
-- Só o dono do banco (o usuário da aplicação) conecta, cria objetos e tabelas temporárias.
-- Papéis futuros (ex.: leitura para relatórios) recebem GRANT explícito na migration que os criar.

-- O PostgreSQL 15+ já não dá CREATE no schema public para PUBLIC; a revogação explícita documenta e
-- garante o mesmo estado em qualquer versão ou imagem.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Por padrão, qualquer papel do servidor pode conectar e criar tabelas temporárias neste banco.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
