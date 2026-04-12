import { prisma } from "./client";

export async function upsertUser(telegramId: number, username?: string) {
  return prisma.user.upsert({
    where: { telegramId: BigInt(telegramId) },
    update: { username },
    create: { telegramId: BigInt(telegramId), username },
  });
}

export async function getUserByTelegramId(telegramId: number) {
  return prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
  });
}
