-- Career profile fields on User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "currentLevel" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "targetRoles"  TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "strengths"    TEXT;

-- Company intelligence fields on FollowedCompany
ALTER TABLE "FollowedCompany" ADD COLUMN IF NOT EXISTS "stack"                 TEXT;
ALTER TABLE "FollowedCompany" ADD COLUMN IF NOT EXISTS "hiringManagerName"     TEXT;
ALTER TABLE "FollowedCompany" ADD COLUMN IF NOT EXISTS "hiringManagerRole"     TEXT;
ALTER TABLE "FollowedCompany" ADD COLUMN IF NOT EXISTS "hiringManagerLinkedIn" TEXT;
ALTER TABLE "FollowedCompany" ADD COLUMN IF NOT EXISTS "fitScore"              DOUBLE PRECISION;

-- Evidence table
CREATE TABLE IF NOT EXISTS "Evidence" (
  "id"            SERIAL PRIMARY KEY,
  "userId"        INTEGER NOT NULL,
  "title"         TEXT NOT NULL,
  "summary"       TEXT NOT NULL,
  "roleType"      TEXT NOT NULL,
  "impact"        TEXT,
  "skills"        TEXT,
  "aiInvolved"    BOOLEAN NOT NULL DEFAULT false,
  "periodFrom"    TIMESTAMP(3),
  "periodTo"      TIMESTAMP(3),
  "artifactsJson" TEXT,
  "rawNotes"      TEXT,
  "order"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Evidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

-- CareerArtifact table
CREATE TABLE IF NOT EXISTS "CareerArtifact" (
  "id"              SERIAL PRIMARY KEY,
  "userId"          INTEGER NOT NULL,
  "type"            TEXT NOT NULL,
  "targetRole"      TEXT,
  "targetCompanyId" INTEGER,
  "content"         TEXT NOT NULL,
  "evidenceIds"     TEXT,
  "version"         INTEGER NOT NULL DEFAULT 1,
  "slug"            TEXT UNIQUE,
  "viewCount"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CareerArtifact_userId_fkey"          FOREIGN KEY ("userId")          REFERENCES "User"("id")            ON DELETE CASCADE,
  CONSTRAINT "CareerArtifact_targetCompanyId_fkey" FOREIGN KEY ("targetCompanyId") REFERENCES "FollowedCompany"("id") ON DELETE SET NULL
);

-- Evidence <-> CareerArtifact many-to-many join table
CREATE TABLE IF NOT EXISTS "_EvidenceToCareerArtifact" (
  "A" INTEGER NOT NULL,
  "B" INTEGER NOT NULL,
  CONSTRAINT "_EvidenceToCareerArtifact_A_fkey" FOREIGN KEY ("A") REFERENCES "Evidence"("id")        ON DELETE CASCADE,
  CONSTRAINT "_EvidenceToCareerArtifact_B_fkey" FOREIGN KEY ("B") REFERENCES "CareerArtifact"("id")  ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "_EvidenceToCareerArtifact_AB_unique" ON "_EvidenceToCareerArtifact"("A", "B");
CREATE INDEX IF NOT EXISTS "_EvidenceToCareerArtifact_B_index" ON "_EvidenceToCareerArtifact"("B");
