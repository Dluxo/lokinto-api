/**
 * One-shot import: reads data_companies_tracker_v2.csv and bulk-follows
 * all valid companies (✅ Global / 🇪🇺 EU-friendly) for the bot owner.
 *
 * Run: npx ts-node src/scripts/import-companies.ts /path/to/csv
 */

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { prisma } from "../db/client";

// ─── ATS detection from careers URL ──────────────────────────────────────────

function detectATS(url: string): { atsType: string | null; atsToken: string | null } {
  if (url.includes("greenhouse.io")) {
    // https://boards.greenhouse.io/figma → token = "figma"
    const m = url.match(/greenhouse\.io\/([^/?#]+)/);
    return { atsType: "greenhouse", atsToken: m?.[1] ?? null };
  }
  if (url.includes("lever.co")) {
    // https://jobs.lever.co/notion → token = "notion"
    const m = url.match(/lever\.co\/([^/?#]+)/);
    return { atsType: "lever", atsToken: m?.[1] ?? null };
  }
  if (url.includes("workable.com")) {
    // https://apply.workable.com/company → token = "company"
    const m = url.match(/workable\.com\/([^/?#]+)/);
    return { atsType: "workable", atsToken: m?.[1] ?? null };
  }
  if (url.includes("ashbyhq.com")) {
    const m = url.match(/ashbyhq\.com\/([^/?#]+)/);
    return { atsType: "ashby", atsToken: m?.[1] ?? null };
  }
  return { atsType: null, atsToken: null };
}

// ─── Parse CSV ────────────────────────────────────────────────────────────────

interface CompanyRow {
  name: string;
  careersUrl: string;
  industry: string;
  remotePolicy: string;
  globalHire: string;
}

function parseCSV(filePath: string): CompanyRow[] {
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  const rows: CompanyRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV split — handles commas in fields wrapped in quotes
    const cols: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') { inQuotes = !inQuotes; continue; }
      if (char === "," && !inQuotes) { cols.push(current.trim()); current = ""; continue; }
      current += char;
    }
    cols.push(current.trim());

    const name       = cols[0] ?? "";
    const industry   = cols[2] ?? "";
    const remotePolicy = cols[4] ?? "";
    const careersUrl = cols[5] ?? "";
    const globalHire = cols[7] ?? "";

    // Skip: no name, no careers URL, open source projects, unverified
    if (!name || !careersUrl) continue;
    if (globalHire.includes("⚠️") || industry.includes("Open Source")) continue;
    if (!globalHire.includes("✅") && !globalHire.includes("🇪🇺")) continue;

    rows.push({ name, careersUrl, industry, remotePolicy, globalHire });
  }

  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = process.argv[2] ?? path.join(process.env.HOME ?? "", "Downloads/data_companies_tracker_v2.csv");

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }

  // Get the bot owner's user ID (telegramId set via env or first user in DB)
  const targetTelegramId = process.env.OWNER_TELEGRAM_ID
    ? BigInt(process.env.OWNER_TELEGRAM_ID)
    : null;

  const user = targetTelegramId
    ? await prisma.user.findUnique({ where: { telegramId: targetTelegramId } })
    : await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });

  if (!user) {
    console.error("No user found in DB. Send /start to your bot first, then re-run.");
    process.exit(1);
  }

  console.log(`Importing companies for user: ${user.username ?? user.telegramId} (id=${user.id})`);

  const rows = parseCSV(csvPath);
  console.log(`Found ${rows.length} valid companies to import\n`);

  let imported = 0;
  let skipped  = 0;

  for (const row of rows) {
    const { atsType, atsToken } = detectATS(row.careersUrl);

    try {
      await prisma.followedCompany.upsert({
        where: { userId_name: { userId: user.id, name: row.name } },
        update: {
          atsType:      atsType ?? "careers_page",
          atsToken:     atsToken ?? null,
          careersUrl:   row.careersUrl,
          desiredRoles: "product designer",
        },
        create: {
          userId:       user.id,
          name:         row.name,
          atsType:      atsType ?? "careers_page",
          atsToken:     atsToken ?? null,
          careersUrl:   row.careersUrl,
          desiredRoles: "product designer",
        },
      });
      console.log(`  ✅ ${row.name} ${atsType ? `(${atsType})` : "(careers page)"}`);
      imported++;
    } catch (err: any) {
      console.log(`  ⚠️  ${row.name} — skipped: ${err.message}`);
      skipped++;
    }
  }

  console.log(`\n✅ Done — ${imported} companies followed, ${skipped} skipped.`);
  console.log(`The Monday monitor will check all of them for product designer roles.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
