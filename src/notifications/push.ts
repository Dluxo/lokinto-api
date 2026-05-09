import Expo, { type ExpoPushMessage } from "expo-server-sdk";

const expo = new Expo();

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Send a push notification to a single Expo push token.
 * Silently ignores invalid / unregistered tokens.
 */
export async function sendPush(token: string, payload: PushPayload): Promise<void> {
  if (!Expo.isExpoPushToken(token)) {
    console.warn("[push] invalid Expo push token:", token);
    return;
  }

  const message: ExpoPushMessage = {
    to: token,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
  };

  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === "error") {
          console.error("[push] delivery error:", receipt.message, receipt.details);
        }
      }
    }
  } catch (err) {
    console.error("[push] send failed:", err);
  }
}

/**
 * Send a push to a user by looking up their stored pushToken.
 * No-ops if the user has no token registered.
 */
export async function sendPushToUser(
  userId: number,
  payload: PushPayload,
): Promise<void> {
  const { prisma } = await import("../db/client");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pushToken: true },
  });
  if (!user?.pushToken) return;
  await sendPush(user.pushToken, payload);
}
