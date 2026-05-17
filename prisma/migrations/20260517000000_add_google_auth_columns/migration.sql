-- Add Google auth and profile columns to User table
-- These were in the schema but never migrated from the Telegram-only init

-- Make telegramId nullable (was NOT NULL in init, nullable in schema)
ALTER TABLE "User" ALTER COLUMN "telegramId" DROP NOT NULL;

-- Add Google auth columns
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "name" TEXT;

-- Add profile columns
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "location" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "experience" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pushToken" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "currentLevel" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "targetRoles" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "strengths" TEXT;

-- Add unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
