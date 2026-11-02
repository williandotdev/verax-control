-- CreateTable
CREATE TABLE "UsedTotpCode" (
    "userId" TEXT NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "usedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UsedTotpCode_pkey" PRIMARY KEY ("userId","code")
);

-- AddForeignKey
ALTER TABLE "UsedTotpCode" ADD CONSTRAINT "UsedTotpCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
