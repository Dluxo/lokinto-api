import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";
import { sendPushToUser } from "../../notifications/push";

const router = Router();
router.use(requireAuth);

const VALID_STATUSES = ["saved", "processing", "applied", "interview", "offer", "rejected", "error"];

// GET /api/pipeline?status=applied — all applications, optionally filtered
router.get("/", async (req: AuthRequest, res: Response) => {
  const status = req.query["status"] as string | undefined;

  if (status && !VALID_STATUSES.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
    return;
  }

  const applications = await prisma.application.findMany({
    where: { userId: req.userId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
  });

  // Group by status for the kanban view
  const grouped = VALID_STATUSES.reduce<Record<string, typeof applications>>(
    (acc, s) => ({ ...acc, [s]: [] }),
    {}
  );
  for (const app of applications) {
    (grouped[app.status] ??= []).push(app);
  }

  res.json({ applications, grouped, total: applications.length });
});

// PUT /api/pipeline/:id — update status or notes
router.put("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const { status, notes } = req.body as { status?: string; notes?: string };

  if (status && !VALID_STATUSES.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
    return;
  }

  const existing = await prisma.application.findFirst({ where: { id, userId: req.userId } });
  if (!existing) { res.status(404).json({ error: "Application not found" }); return; }

  const updated = await prisma.application.update({
    where: { id },
    data: {
      ...(status ? { status } : {}),
      ...(notes  !== undefined ? { notes } : {}),
      // Auto-set appliedAt when moving to "applied"
      ...(status === "applied" && !existing.appliedAt ? { appliedAt: new Date() } : {}),
    },
  });

  // Create a notification for key status transitions
  const notifyOn: Record<string, { title: string; body: string }> = {
    interview: {
      title: `Interview stage — ${existing.company}`,
      body: `Update your notes and prepare for your ${existing.jobTitle} interview`,
    },
    offer: {
      title: `Offer received — ${existing.company}! 🎉`,
      body: `Congratulations! You have an offer for ${existing.jobTitle}`,
    },
  };

  if (status && notifyOn[status]) {
    const { title, body } = notifyOn[status];
    await prisma.notification.create({
      data: {
        userId: req.userId!,
        type: status,
        title,
        body,
        metadata: { applicationId: id },
      },
    });
    sendPushToUser(req.userId!, {
      title,
      body,
      data: { screen: "pipeline", applicationId: id },
    }).catch(() => {});
  }

  res.json(updated);
});

// DELETE /api/pipeline/:id — remove from pipeline
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  await prisma.application.deleteMany({ where: { id, userId: req.userId } });
  res.json({ ok: true });
});

export default router;
