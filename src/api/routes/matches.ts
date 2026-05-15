import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const router = Router();
router.use(requireAuth);

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── helpers ──────────────────────────────────────────────────────────────────

async function generateMatches(userId: number) {
  // 1. Load user context
  const [user, evidence, companies] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { targetRoles: true, currentLevel: true, jobTitle: true },
    }),
    prisma.evidence.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { title: true, roleType: true, impact: true, skills: true, summary: true },
    }),
    prisma.followedCompany.findMany({
      where: { userId, fitScore: { not: null } },
      orderBy: { fitScore: "desc" },
      take: 15,
      include: {
        alerts: {
          orderBy: { sentAt: "desc" },
          take: 3,
          select: { jobTitle: true, jobUrl: true },
        },
      },
    }),
  ]);

  if (!evidence.length || !companies.length) return [];

  const targetRoles: string[] = (() => {
    try { return user?.targetRoles ? JSON.parse(user.targetRoles) : [user?.jobTitle ?? "tech role"]; }
    catch { return [user?.jobTitle ?? "tech role"]; }
  })();

  const evidenceSummary = evidence
    .map((e) => `[${e.roleType}] ${e.title} — ${e.impact ?? "no metric"} | skills: ${e.skills ?? "n/a"}`)
    .join("\n");

  // 2. Build opportunity list: real alerts + generic company slots
  const opportunities: Array<{
    companyId: number;
    companyName: string;
    industry: string | null;
    continent: string | null;
    fitScore: number;
    jobTitle: string;
    jobUrl: string | null;
    isGeneric: boolean;
  }> = [];

  for (const company of companies) {
    if (company.alerts.length > 0) {
      for (const alert of company.alerts) {
        opportunities.push({
          companyId: company.id,
          companyName: company.name,
          industry: company.industry,
          continent: company.continent,
          fitScore: company.fitScore!,
          jobTitle: alert.jobTitle,
          jobUrl: alert.jobUrl,
          isGeneric: false,
        });
      }
    } else {
      // No specific openings — generate a generic match
      opportunities.push({
        companyId: company.id,
        companyName: company.name,
        industry: company.industry,
        continent: company.continent,
        fitScore: company.fitScore!,
        jobTitle: targetRoles[0] ?? "tech role",
        jobUrl: null,
        isGeneric: true,
      });
    }
  }

  if (!opportunities.length) return [];

  // 3. Single GPT call — score + explain all opportunities
  const oppList = opportunities
    .map((o, i) =>
      `${i + 1}. [id:${i}] "${o.jobTitle}" at ${o.companyName}` +
      ` (${o.industry ?? "tech"}, fit=${Math.round(o.fitScore * 100)}%)`
    )
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You match a candidate's evidence to job opportunities.
For each opportunity, return a match score and short explanation.
Return JSON: { matches: Array<{ id: number, matchScore: number (0-1), reason: string (max 15 words), skills: string[] (max 3) }> }
Only include opportunities where matchScore >= 0.35.`,
      },
      {
        role: "user",
        content: `Target roles: ${targetRoles.join(", ")}
Level: ${user?.currentLevel ?? "not specified"}

Candidate evidence:
${evidenceSummary}

Opportunities to score:
${oppList}`,
      },
    ],
  });

  let aiMatches: Array<{ id: number; matchScore: number; reason: string; skills: string[] }> = [];
  try {
    const parsed = JSON.parse(completion.choices[0].message.content ?? "{}");
    aiMatches = parsed.matches ?? [];
  } catch {
    return [];
  }

  // 4. Merge AI scores with opportunity metadata, persist to cache
  const toCreate = aiMatches
    .filter((m) => m.id >= 0 && m.id < opportunities.length)
    .map((m) => {
      const opp = opportunities[m.id];
      return {
        userId,
        companyId: opp.companyId,
        jobTitle: opp.jobTitle,
        jobUrl: opp.jobUrl,
        matchScore: Math.max(0, Math.min(1, Number(m.matchScore) || 0)),
        matchReason: m.reason ?? "",
        matchSkills: JSON.stringify(m.skills ?? []),
        isGeneric: opp.isGeneric,
      };
    });

  // Clear old matches for this user then insert fresh
  await prisma.jobMatch.deleteMany({ where: { userId } });
  if (toCreate.length > 0) {
    await prisma.jobMatch.createMany({ data: toCreate });
  }

  return prisma.jobMatch.findMany({
    where: { userId },
    orderBy: { matchScore: "desc" },
    include: {
      company: {
        select: { id: true, name: true, industry: true, continent: true, remoteFriendly: true, fitScore: true, careersUrl: true },
      },
    },
  });
}

// ── routes ───────────────────────────────────────────────────────────────────

// GET /api/matches — return cached or recompute
router.get("/", async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  // Check cache freshness
  const newest = await prisma.jobMatch.findFirst({
    where: { userId },
    orderBy: { generatedAt: "desc" },
    select: { generatedAt: true },
  });

  const isFresh = newest && (Date.now() - newest.generatedAt.getTime() < CACHE_TTL_MS);

  if (isFresh) {
    const matches = await prisma.jobMatch.findMany({
      where: { userId },
      orderBy: { matchScore: "desc" },
      include: {
        company: {
          select: { id: true, name: true, industry: true, continent: true, remoteFriendly: true, fitScore: true, careersUrl: true },
        },
      },
    });
    return res.json({ matches, cached: true, generatedAt: newest.generatedAt });
  }

  const matches = await generateMatches(userId);
  const generatedAt = matches[0]?.generatedAt ?? new Date();
  return res.json({ matches, cached: false, generatedAt });
});

// POST /api/matches/refresh — force recompute
router.post("/refresh", async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  // Check user has evidence + followed companies
  const [evidenceCount, companiesCount] = await Promise.all([
    prisma.evidence.count({ where: { userId } }),
    prisma.followedCompany.count({ where: { userId, fitScore: { not: null } } }),
  ]);

  if (evidenceCount === 0) {
    return res.status(400).json({ error: "No evidence found. Log achievements first." });
  }
  if (companiesCount === 0) {
    return res.status(400).json({ error: "No scored companies found. Score company fit first." });
  }

  const matches = await generateMatches(userId);
  const generatedAt = matches[0]?.generatedAt ?? new Date();
  return res.json({ matches, cached: false, generatedAt });
});

export default router;
