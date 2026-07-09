-- AlterTable: extend JobSource with poller fields
ALTER TABLE "JobSource" ADD COLUMN "adapter" TEXT;
ALTER TABLE "JobSource" ADD COLUMN "lastJobCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "JobPosting" (
    "id"         SERIAL NOT NULL,
    "sourceId"   INTEGER NOT NULL,
    "externalId" TEXT,
    "title"      TEXT NOT NULL,
    "company"    TEXT NOT NULL,
    "location"   TEXT,
    "url"        TEXT NOT NULL,
    "jobType"    TEXT,
    "salary"     TEXT,
    "tags"       TEXT,
    "postedAt"   TIMESTAMP(3),
    "fetchedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobPosting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobPosting_sourceId_url_key" ON "JobPosting"("sourceId", "url");
CREATE INDEX "JobPosting_sourceId_postedAt_idx" ON "JobPosting"("sourceId", "postedAt");

-- AddForeignKey
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "JobSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tag the sources that have a pollable public API
UPDATE "JobSource" SET "adapter" = 'remoteok'      WHERE "name" = 'RemoteOK';
UPDATE "JobSource" SET "adapter" = 'jobicy'        WHERE "name" = 'Jobicy';
UPDATE "JobSource" SET "adapter" = 'remotive'      WHERE "name" = 'Remotive';
UPDATE "JobSource" SET "adapter" = 'workingnomads' WHERE "name" = 'Working Nomads';
