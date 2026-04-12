import { prisma } from "./client";

// ─── Work Items ───────────────────────────────────────────────────────────────

export async function addWorkItem(
  userId: number,
  data: {
    title: string;
    description: string;
    role?: string;
    tools?: string;
    outcome?: string;
    imageUrl?: string;
    projectUrl?: string;
    tags?: string;
    sectionsJson?: string;
    fileHash?: string;
  }
) {
  return prisma.workItem.create({
    data: {
      userId,
      title: data.title,
      description: data.description,
      role: data.role,
      tools: data.tools,
      outcome: data.outcome,
      imageUrl: data.imageUrl,
      projectUrl: data.projectUrl,
      tags: data.tags,
      sectionsJson: data.sectionsJson,
    fileHash: data.fileHash,
    },
  });
}

export async function findWorkItemByHash(userId: number, fileHash: string) {
  return prisma.workItem.findFirst({ where: { userId, fileHash } });
}

export async function getWorkItems(userId: number) {
  return prisma.workItem.findMany({
    where: { userId },
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
  });
}

export async function deleteWorkItem(userId: number, itemId: number) {
  return prisma.workItem.deleteMany({
    where: { id: itemId, userId },
  });
}

// ─── Portfolios ───────────────────────────────────────────────────────────────

export async function savePortfolio(
  userId: number,
  data: {
    slug: string;
    jobTitle?: string;
    company?: string;
    htmlContent: string;
  }
) {
  return prisma.portfolio.upsert({
    where: { slug: data.slug },
    update: {
      jobTitle: data.jobTitle,
      company: data.company,
      htmlContent: data.htmlContent,
    },
    create: {
      userId,
      slug: data.slug,
      jobTitle: data.jobTitle,
      company: data.company,
      htmlContent: data.htmlContent,
    },
  });
}

export async function getPortfolioBySlug(slug: string) {
  return prisma.portfolio.findUnique({ where: { slug } });
}

export async function incrementViewCount(slug: string) {
  return prisma.portfolio.update({
    where: { slug },
    data: { viewCount: { increment: 1 } },
  });
}

export async function getWorkItemById(id: number) {
  return prisma.workItem.findUnique({ where: { id } });
}

export async function getUserPortfolios(userId: number) {
  return prisma.portfolio.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}
