import { prisma } from "./client";

export async function saveUserCV(userId: number, filename: string, rawText: string, fileHash?: string) {
  return prisma.userCV.upsert({
    where:  { userId },
    update: { filename, rawText, fileHash, updatedAt: new Date() },
    create: { userId, filename, rawText, fileHash },
  });
}

export async function findCVByHash(userId: number, fileHash: string) {
  return prisma.userCV.findFirst({ where: { userId, fileHash } });
}

export async function getUserCV(userId: number) {
  return prisma.userCV.findUnique({ where: { userId } });
}

export async function deleteUserCV(userId: number) {
  return prisma.userCV.deleteMany({ where: { userId } });
}
