-- AlterTable
ALTER TABLE "FollowedCompany"
  ADD COLUMN "industry"       TEXT,
  ADD COLUMN "continent"      TEXT,
  ADD COLUMN "remoteFriendly" BOOLEAN NOT NULL DEFAULT false;
