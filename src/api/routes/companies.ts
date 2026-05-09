import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";
import { runMonitorForUser } from "../../jobs/monitor";

const router = Router();
router.use(requireAuth);

// GET /api/companies/search?q=figma — search known companies
router.get("/search", async (req: AuthRequest, res: Response) => {
  const q = ((req.query["q"] as string) ?? "").trim();

  // Search across all followed companies (distinct names) as a global directory
  const companies = await prisma.followedCompany.findMany({
    where: q ? { name: { contains: q, mode: "insensitive" } } : {},
    distinct: ["name"],
    select: { name: true, atsType: true, careersUrl: true },
    orderBy: { name: "asc" },
    take: 30,
  });

  res.json(companies);
});

// GET /api/companies/followed — companies the user follows
router.get("/followed", async (req: AuthRequest, res: Response) => {
  const companies = await prisma.followedCompany.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: "desc" },
  });
  res.json(companies);
});

// POST /api/companies/follow — follow a company
router.post("/follow", async (req: AuthRequest, res: Response) => {
  const { name, desiredRoles = "designer", careersUrl } = req.body as {
    name?: string;
    desiredRoles?: string;
    careersUrl?: string;
  };

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const company = await prisma.followedCompany.upsert({
    where: { userId_name: { userId: req.userId!, name } },
    update: { desiredRoles, careersUrl },
    create: { userId: req.userId!, name, desiredRoles, careersUrl },
  });
  res.status(201).json(company);
});

// DELETE /api/companies/follow/:name — unfollow a company
router.delete("/follow/:name", async (req: AuthRequest, res: Response) => {
  const name = decodeURIComponent(req.params["name"] as string);
  await prisma.followedCompany.deleteMany({ where: { userId: req.userId, name } });
  res.json({ ok: true });
});

// GET /api/companies/industries — user's industry follows
router.get("/industries", async (req: AuthRequest, res: Response) => {
  const industries = await prisma.industryFollow.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: "desc" },
  });
  res.json(industries.map((i) => i.industry));
});

// POST /api/companies/industries — follow an industry (or bulk: { industries: string[] })
router.post("/industries", async (req: AuthRequest, res: Response) => {
  const body = req.body as { industry?: string; industries?: string[] };

  const list: string[] = body.industries?.length
    ? body.industries
    : body.industry
      ? [body.industry]
      : [];

  if (list.length === 0) {
    res.status(400).json({ error: "industry or industries is required" });
    return;
  }

  await Promise.all(
    list.map((industry) =>
      prisma.industryFollow.upsert({
        where: { userId_industry: { userId: req.userId!, industry } },
        update: {},
        create: { userId: req.userId!, industry },
      })
    )
  );
  res.status(201).json({ ok: true, industries: list });
});

// DELETE /api/companies/industries/:name — unfollow an industry
router.delete("/industries/:name", async (req: AuthRequest, res: Response) => {
  const industry = decodeURIComponent(req.params["name"] as string);
  await prisma.industryFollow.deleteMany({ where: { userId: req.userId, industry } });
  res.json({ ok: true });
});

// POST /api/companies/scan — trigger an on-demand job scan for the current user
router.post("/scan", async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  setImmediate(async () => {
    try { await runMonitorForUser(userId); } catch (err) { console.error("[scan]", err); }
  });
  res.json({ ok: true, message: "Scan started" });
});

export default router;
