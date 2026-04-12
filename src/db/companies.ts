import { prisma } from "./client";

export async function followCompany(
  userId: number,
  data: {
    name: string;
    atsType?: string;
    atsToken?: string;
    desiredRoles?: string;
  }
) {
  return prisma.followedCompany.upsert({
    where: { userId_name: { userId, name: data.name } },
    create: {
      userId,
      name: data.name,
      atsType: data.atsType,
      atsToken: data.atsToken,
      desiredRoles: data.desiredRoles ?? "designer",
    },
    update: {
      atsType: data.atsType,
      atsToken: data.atsToken,
      desiredRoles: data.desiredRoles ?? "designer",
    },
  });
}

export async function unfollowCompany(userId: number, companyName: string) {
  try {
    return await prisma.followedCompany.delete({
      where: { userId_name: { userId, name: companyName } },
    });
  } catch {
    // Record may not exist — silently ignore
    return null;
  }
}

export async function getFollowedCompanies(userId: number) {
  return prisma.followedCompany.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateLastChecked(companyId: number) {
  return prisma.followedCompany.update({
    where: { id: companyId },
    data: { lastChecked: new Date() },
  });
}

export async function recordAlert(
  userId: number,
  companyId: number,
  jobTitle: string,
  jobUrl: string
) {
  try {
    return await prisma.jobAlert.create({
      data: { userId, companyId, jobTitle, jobUrl },
    });
  } catch {
    // Duplicate unique constraint — already alerted, ignore
    return null;
  }
}

export async function getAlertedUrls(companyId: number): Promise<string[]> {
  const alerts = await prisma.jobAlert.findMany({
    where: { companyId },
    select: { jobUrl: true },
  });
  return alerts.map((a) => a.jobUrl);
}

export async function getAllFollowedCompanies() {
  return prisma.followedCompany.findMany({
    include: { user: true },
    orderBy: { lastChecked: "asc" },
  });
}
