import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";

const router = Router();
router.use(requireAuth);

// GET /api/leads
router.get("/", async (req: AuthRequest, res: Response) => {
  const leads = await prisma.savedLead.findMany({
    where: { userId: req.userId },
    orderBy: { savedAt: "desc" },
  });
  res.json(leads);
});

// POST /api/leads
router.post("/", async (req: AuthRequest, res: Response) => {
  const { name, company, role, email, linkedIn, source } = req.body as {
    name?: string; company?: string; role?: string;
    email?: string; linkedIn?: string; source?: string;
  };

  if (!name || !company) {
    res.status(400).json({ error: "name and company are required" });
    return;
  }

  const lead = await prisma.savedLead.upsert({
    where: { userId_company_name: { userId: req.userId!, company, name } },
    update: { role, email, linkedIn, source },
    create: { userId: req.userId!, name, company, role, email, linkedIn, source },
  });
  res.status(201).json(lead);
});

// DELETE /api/leads/:id
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  await prisma.savedLead.deleteMany({ where: { id, userId: req.userId } });
  res.json({ ok: true });
});

export default router;
