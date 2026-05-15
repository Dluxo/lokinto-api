-- CreateTable: JobMatch — caches AI-generated match explanations per user/company/role
CREATE TABLE "JobMatch" (
    "id"          SERIAL PRIMARY KEY,
    "userId"      INTEGER NOT NULL,
    "companyId"   INTEGER NOT NULL,
    "jobTitle"    TEXT NOT NULL,
    "jobUrl"      TEXT,
    "matchScore"  DOUBLE PRECISION NOT NULL,
    "matchReason" TEXT NOT NULL,
    "matchSkills" TEXT,
    "isGeneric"   BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobMatch_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User"("id")            ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JobMatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "FollowedCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "JobMatch_userId_generatedAt_idx" ON "JobMatch"("userId", "generatedAt");
