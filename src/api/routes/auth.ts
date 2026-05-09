import { Router, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import { prisma } from "../../db/client";
import { signAccessToken } from "../middleware/auth";

const router = Router();
const googleClient = new OAuth2Client();
const GOOGLE_AUDIENCES = [
  process.env.GOOGLE_CLIENT_ID!,                                               // web client ID
  "129137267859-ai3prh8i6vfe053dte1j5dea4uv38gm1.apps.googleusercontent.com", // iOS client ID
].filter(Boolean);
const REFRESH_EXPIRY_DAYS = 30;

// POST /api/auth/google — exchange Google ID token for session
router.post("/google", async (req: Request, res: Response) => {
  const { idToken } = req.body as { idToken?: string };
  if (!idToken) {
    res.status(400).json({ error: "idToken is required" });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_AUDIENCES,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) throw new Error("Empty Google payload");

    const { sub: googleId, email, name } = payload;

    const user = await prisma.user.upsert({
      where: { googleId },
      update: { email, name },
      create: { googleId, email, name },
      select: { id: true, email: true, name: true, jobTitle: true, location: true, experience: true },
    });

    const refreshToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_DAYS * 86_400_000);
    await prisma.authToken.create({
      data: { userId: user.id, token: refreshToken, expiresAt },
    });

    res.json({ accessToken: signAccessToken(user.id), refreshToken, user });
  } catch (err) {
    console.error("[auth/google]", err);
    res.status(401).json({ error: "Invalid Google token" });
  }
});

// POST /api/auth/refresh — rotate refresh token, issue new access token
router.post("/refresh", async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    res.status(400).json({ error: "refreshToken is required" });
    return;
  }

  const record = await prisma.authToken.findUnique({ where: { token: refreshToken } });
  if (!record || record.expiresAt < new Date()) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const newRefreshToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_DAYS * 86_400_000);
  await prisma.authToken.update({
    where: { id: record.id },
    data: { token: newRefreshToken, expiresAt },
  });

  res.json({ accessToken: signAccessToken(record.userId), refreshToken: newRefreshToken });
});

// POST /api/auth/logout — invalidate refresh token
router.post("/logout", async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (refreshToken) {
    await prisma.authToken.deleteMany({ where: { token: refreshToken } });
  }
  res.json({ ok: true });
});

export default router;
