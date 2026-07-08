import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";

const router = Router();
router.use(requireAuth);

// GET /api/job-sources — list all tracked remote job websites
router.get("/", async (_req: AuthRequest, res: Response) => {
  const sources = await prisma.jobSource.findMany({
    orderBy: [{ sourceCount: "desc" }, { name: "asc" }],
  });
  res.json({ sources });
});

// GET /api/job-sources/:id
router.get("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const source = await prisma.jobSource.findUnique({ where: { id } });
  if (!source) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ source });
});

// PATCH /api/job-sources/:id — toggle active, update lastCheckedAt, etc.
router.patch("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const { active, lastCheckedAt } = req.body as {
    active?: boolean;
    lastCheckedAt?: string;
  };

  const source = await prisma.jobSource.update({
    where: { id },
    data: {
      ...(active !== undefined ? { active } : {}),
      ...(lastCheckedAt ? { lastCheckedAt: new Date(lastCheckedAt) } : {}),
    },
  });
  res.json({ source });
});

export default router;
