import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";
import { pollAllSources, pollSource } from "../../actions/jobSourcePoller";

const router = Router();
router.use(requireAuth);

// GET /api/job-sources — list all tracked remote job websites
router.get("/", async (_req: AuthRequest, res: Response) => {
  const sources = await prisma.jobSource.findMany({
    orderBy: [{ sourceCount: "desc" }, { name: "asc" }],
    include: { _count: { select: { postings: true } } },
  });
  res.json({ sources });
});

// GET /api/job-sources/postings — recent postings across all sources
router.get("/postings", async (req: AuthRequest, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"] ?? 50)));
  const postings = await prisma.jobPosting.findMany({
    orderBy: [{ postedAt: "desc" }, { fetchedAt: "desc" }],
    take: limit,
    include: { source: { select: { name: true, url: true } } },
  });
  res.json({ postings });
});

// POST /api/job-sources/poll — trigger a poll of all adapter-backed sources
router.post("/poll", async (_req: AuthRequest, res: Response) => {
  try {
    const results = await pollAllSources();
    const totalNew = results.reduce((n, r) => n + r.created, 0);
    res.json({ ok: true, totalNew, results });
  } catch (err: any) {
    console.error("[job-sources/poll]", err);
    res.status(500).json({ error: "Poll failed" });
  }
});

// GET /api/job-sources/:id — single source
router.get("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const source = await prisma.jobSource.findUnique({
    where: { id },
    include: { _count: { select: { postings: true } } },
  });
  if (!source) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ source });
});

// GET /api/job-sources/:id/postings — postings from one source
router.get("/:id/postings", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"] ?? 50)));
  const postings = await prisma.jobPosting.findMany({
    where: { sourceId: id },
    orderBy: [{ postedAt: "desc" }, { fetchedAt: "desc" }],
    take: limit,
  });
  res.json({ postings });
});

// POST /api/job-sources/:id/poll — poll a single source
router.post("/:id/poll", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const source = await prisma.jobSource.findUnique({ where: { id } });
  if (!source) { res.status(404).json({ error: "Not found" }); return; }

  const result = await pollSource(source);
  res.json({ ok: !result.error, result });
});

// PATCH /api/job-sources/:id — toggle active / update fields
router.patch("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const { active, adapter } = req.body as { active?: boolean; adapter?: string | null };

  const source = await prisma.jobSource.update({
    where: { id },
    data: {
      ...(active !== undefined ? { active } : {}),
      ...(adapter !== undefined ? { adapter } : {}),
    },
  });
  res.json({ source });
});

export default router;
