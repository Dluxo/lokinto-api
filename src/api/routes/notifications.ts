import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";

const router = Router();
router.use(requireAuth);

// GET /api/notifications — latest 50 notifications
router.get("/", async (req: AuthRequest, res: Response) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const unreadCount = notifications.filter((n) => !n.read).length;
  res.json({ notifications, unreadCount });
});

// PUT /api/notifications/read — mark all as read
router.put("/read", async (req: AuthRequest, res: Response) => {
  const { count } = await prisma.notification.updateMany({
    where: { userId: req.userId, read: false },
    data: { read: true },
  });
  res.json({ ok: true, marked: count });
});

// PUT /api/notifications/:id/read — mark one as read
router.put("/:id/read", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  await prisma.notification.updateMany({
    where: { id, userId: req.userId },
    data: { read: true },
  });
  res.json({ ok: true });
});

// DELETE /api/notifications/:id — dismiss
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  await prisma.notification.deleteMany({ where: { id, userId: req.userId } });
  res.json({ ok: true });
});

export default router;
