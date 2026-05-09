import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";

const router = Router();
router.use(requireAuth);

// GET /api/me — current user profile + counts
router.get("/", async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      email: true,
      name: true,
      jobTitle: true,
      location: true,
      experience: true,
      createdAt: true,
      _count: {
        select: {
          applications: true,
          followedCompanies: true,
          workItems: true,
          notifications: true,
        },
      },
    },
  });
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json(user);
});

// PUT /api/me — update profile
router.put("/", async (req: AuthRequest, res: Response) => {
  const { name, jobTitle, location, experience } = req.body as {
    name?: string;
    jobTitle?: string;
    location?: string;
    experience?: string;
  };

  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { name, jobTitle, location, experience },
    select: { id: true, email: true, name: true, jobTitle: true, location: true, experience: true },
  });
  res.json(user);
});

// POST /api/me/push-token — register or update Expo push token
router.post("/push-token", async (req: AuthRequest, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token) { res.status(400).json({ error: "token is required" }); return; }

  await prisma.user.update({
    where: { id: req.userId },
    data: { pushToken: token },
  });
  res.json({ ok: true });
});

// DELETE /api/me/push-token — unregister on logout
router.delete("/push-token", async (req: AuthRequest, res: Response) => {
  await prisma.user.update({
    where: { id: req.userId },
    data: { pushToken: null },
  });
  res.json({ ok: true });
});

export default router;
