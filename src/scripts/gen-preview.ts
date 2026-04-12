import * as dotenv from "dotenv";
dotenv.config({ path: "/Users/diogoluxo/Documents/gig-bot/.env", override: true });
import * as fs from "fs";
import * as path from "path";
import { generatePortfolio } from "../actions/portfolioGenerator";
import { addWorkItem, getWorkItems, savePortfolio } from "../db/portfolio";
import { prisma } from "../db/client";

const PREVIEW_USER_TELEGRAM_ID = 999999;
const PREVIEW_SLUG = "preview";
const LOCAL_BASE = "http://localhost:3000";

async function main() {
  // Ensure preview user exists
  const user = await prisma.user.upsert({
    where: { telegramId: PREVIEW_USER_TELEGRAM_ID },
    update: {},
    create: { telegramId: PREVIEW_USER_TELEGRAM_ID, username: "preview" },
  });
  const previewUserId = user.id;

  // Delete old preview work items
  await prisma.workItem.deleteMany({ where: { userId: previewUserId } });

  // Pull real user's work items — skip duplicates by title, take latest per title
  const allReal = await prisma.workItem.findMany({
    where: {
      userId: { not: previewUserId },
      NOT: { title: "Add use case" },
      sectionsJson: { not: null },
    },
    orderBy: { id: "asc" },
  });

  // Deduplicate by title — keep the last occurrence
  const seen = new Map<string, typeof allReal[0]>();
  for (const item of allReal) seen.set(item.title, item);
  const realItems = Array.from(seen.values());

  // Create preview copies with localhost image URLs
  for (const item of realItems) {
    const localImageUrl = item.imageUrl
      ? item.imageUrl
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean)
          .map((u) => u.replace(/https?:\/\/[^/]+/, LOCAL_BASE))
          .join(",")
      : undefined;

    await addWorkItem(previewUserId, {
      title:       item.title,
      description: item.description,
      role:        item.role        ?? undefined,
      tools:       item.tools       ?? undefined,
      outcome:     item.outcome     ?? undefined,
      imageUrl:    localImageUrl,
      tags:        item.tags        ?? undefined,
      sectionsJson: item.sectionsJson ?? undefined,
    });
  }

  const workItems = await getWorkItems(previewUserId);

  const html = await generatePortfolio({
    ownerName: "Diogo Luxo",
    bio: "Senior product designer specialising in developer experience, SaaS platforms, and product-led growth. I turn complex systems into intuitive flows that drive activation and retention.",
    contact: "diogo@example.com",
    jobTitle: "Senior Product Designer",
    company: "Figma",
    jobDescription:
      "We are looking for a Senior Product Designer to join Figma. You will work on core product experiences used by millions of designers. We value systems thinking, strong interaction design, and collaboration with engineers and PMs. Experience with developer tools or complex B2B products is highly valued.",
    workItems: workItems.map((w) => ({
      id:          w.id,
      title:       w.title,
      description: w.description,
      role:        w.role        ?? undefined,
      tools:       w.tools       ?? undefined,
      outcome:     w.outcome     ?? undefined,
      imageUrl:    w.imageUrl    ?? undefined,
      projectUrl:  w.projectUrl  ?? undefined,
      tags:        w.tags        ?? undefined,
      sectionsJson: w.sectionsJson ?? undefined,
    })),
    slug: PREVIEW_SLUG,
  });

  await savePortfolio(previewUserId, {
    slug: PREVIEW_SLUG,
    jobTitle: "Senior Product Designer",
    company: "Figma",
    htmlContent: html,
  });

  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "preview.html"), html);

  console.log(`✅ Preview saved at /p/preview`);
  console.log(`   ${workItems.length} case studies: ${workItems.map((w) => `"${w.title}" (ID ${w.id})`).join(", ")}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
