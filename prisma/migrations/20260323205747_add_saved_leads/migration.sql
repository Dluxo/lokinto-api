-- CreateTable
CREATE TABLE "SavedLead" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "company" TEXT NOT NULL,
    "email" TEXT,
    "linkedIn" TEXT,
    "source" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SavedLead_userId_company_name_key" ON "SavedLead"("userId", "company", "name");

-- AddForeignKey
ALTER TABLE "SavedLead" ADD CONSTRAINT "SavedLead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
