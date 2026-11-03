-- Cursor de continuação do sync (T5.3): uma execução que bate o limite de páginas deixa a próxima seguir de onde parou.

-- AlterTable
ALTER TABLE "SyncState" ADD COLUMN     "cursorId" VARCHAR(128),
ADD COLUMN     "cursorTimestamp" TIMESTAMPTZ(3);

