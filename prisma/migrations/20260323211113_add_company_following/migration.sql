-- CreateTable
CREATE TABLE "FollowedCompany" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "atsType" TEXT,
    "atsToken" TEXT,
    "desiredRoles" TEXT NOT NULL DEFAULT 'designer',
    "lastChecked" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowedCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAlert" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "jobUrl" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FollowedCompany_userId_name_key" ON "FollowedCompany"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "JobAlert_companyId_jobUrl_key" ON "JobAlert"("companyId", "jobUrl");

-- AddForeignKey
ALTER TABLE "FollowedCompany" ADD CONSTRAINT "FollowedCompany_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAlert" ADD CONSTRAINT "JobAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAlert" ADD CONSTRAINT "JobAlert_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "FollowedCompany"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
