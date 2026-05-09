import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";

const router = Router();
router.use(requireAuth);

// GET /api/jobs — paginated job alerts for the user
router.get("/", async (req: AuthRequest, res: Response) => {
  const page  = Math.max(1, Number(req.query["page"]  ?? 1));
  const limit = Math.min(50, Math.max(1, Number(req.query["limit"] ?? 20)));
  const skip  = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    prisma.jobAlert.findMany({
      where: { userId: req.userId },
      include: { company: { select: { name: true, desiredRoles: true, atsType: true } } },
      orderBy: { sentAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.jobAlert.count({ where: { userId: req.userId } }),
  ]);

  res.json({ jobs, total, page, limit, pages: Math.ceil(total / limit) });
});

// GET /api/jobs/:id — single job alert
router.get("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const job = await prisma.jobAlert.findFirst({
    where: { id, userId: req.userId },
    include: { company: { select: { name: true, desiredRoles: true, atsType: true, careersUrl: true } } },
  });
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

// GET /api/jobs/saved — user's bookmarked jobs
router.get("/saved", async (req: AuthRequest, res: Response) => {
  const jobs = await prisma.savedJob.findMany({
    where: { userId: req.userId },
    orderBy: { savedAt: "desc" },
  });
  res.json(jobs);
});

// POST /api/jobs/save — save a job manually
router.post("/save", async (req: AuthRequest, res: Response) => {
  const { title, company, location = "", url, salary, jobType, source } = req.body as {
    title?: string; company?: string; location?: string;
    url?: string; salary?: string; jobType?: string; source?: string;
  };

  if (!title || !company || !url) {
    res.status(400).json({ error: "title, company, and url are required" });
    return;
  }

  const job = await prisma.savedJob.upsert({
    where: { userId_url: { userId: req.userId!, url } },
    update: { title, company, location, salary, jobType, source },
    create: { userId: req.userId!, title, company, location, url, salary, jobType, source },
  });
  res.status(201).json(job);
});

// DELETE /api/jobs/save/:id — unsave a job
router.delete("/save/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  await prisma.savedJob.deleteMany({ where: { id, userId: req.userId } });
  res.json({ ok: true });
});

export default router;
