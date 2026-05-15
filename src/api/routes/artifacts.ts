import { Router } from "express";
import { prisma } from "../../db/client";
import { requireAuth } from "../middleware/auth";
import { nanoid } from "nanoid";
import { anthropic } from "../../ai/client";

const router = Router();
router.use(requireAuth);

type ArtifactType = "cv" | "interview_pack" | "case_study" | "skill_proof" | "outreach_message";

// GET /api/artifacts
router.get("/", async (req, res) => {
  const userId = (req as any).userId as number;
  const { type } = req.query;

  const artifacts = await prisma.careerArtifact.findMany({
    where: { userId, ...(type ? { type: String(type) } : {}) },
    include: { targetCompany: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  res.json({ artifacts });
});

// GET /api/artifacts/:id
router.get("/:id", async (req, res) => {
  const userId = (req as any).userId as number;
  const id = Number(req.params.id);

  const artifact = await prisma.careerArtifact.findFirst({
    where: { id, userId },
    include: { evidence: true, targetCompany: { select: { id: true, name: true, careersUrl: true } } },
  });

  if (!artifact) return res.status(404).json({ error: "Not found" });
  res.json({ artifact });
});

// POST /api/artifacts/generate — generate an artifact from evidence + context
router.post("/generate", async (req, res) => {
  const userId = (req as any).userId as number;
  const { type, targetRole, targetCompanyId, evidenceIds }: {
    type: ArtifactType;
    targetRole?: string;
    targetCompanyId?: number;
    evidenceIds?: number[];
  } = req.body;

  if (!type) return res.status(400).json({ error: "type required" });

  // Load evidence — use specified IDs or all user evidence
  const evidence = await prisma.evidence.findMany({
    where: {
      userId,
      ...(evidenceIds?.length ? { id: { in: evidenceIds } } : {}),
    },
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
  });

  if (!evidence.length) {
    return res.status(400).json({ error: "No evidence found. Add achievements first." });
  }

  // Load company context if provided
  let companyContext = "";
  if (targetCompanyId) {
    const company = await prisma.followedCompany.findFirst({
      where: { id: targetCompanyId, userId },
    });
    if (company) {
      companyContext = `\nTarget company: ${company.name} (${company.industry ?? "tech"}, ${company.continent ?? "global"}).`;
      if (company.stack) companyContext += ` Their stack: ${company.stack}.`;
      if (company.hiringManagerName) companyContext += ` Hiring manager: ${company.hiringManagerName} (${company.hiringManagerRole ?? "unknown role"}).`;
    }
  }

  const evidenceSummary = evidence.map((e, i) =>
    `${i + 1}. [${e.roleType.toUpperCase()}] ${e.title}\n   Summary: ${e.summary}\n   Impact: ${e.impact ?? "not specified"}\n   Skills: ${e.skills ?? "not specified"}\n   AI involved: ${e.aiInvolved}`
  ).join("\n\n");

  const content = await generateArtifact(type, evidenceSummary, targetRole, companyContext);

  const usedIds = evidence.map((e) => e.id);
  const slug = type === "case_study" ? nanoid(10) : null;

  const artifact = await prisma.careerArtifact.create({
    data: {
      userId,
      type,
      targetRole:      targetRole      ?? null,
      targetCompanyId: targetCompanyId ?? null,
      content,
      evidenceIds:     JSON.stringify(usedIds),
      slug,
      evidence: { connect: usedIds.map((id) => ({ id })) },
    },
  });

  res.status(201).json({ artifact });
});

// DELETE /api/artifacts/:id
router.delete("/:id", async (req, res) => {
  const userId = (req as any).userId as number;
  const id = Number(req.params.id);

  const existing = await prisma.careerArtifact.findFirst({ where: { id, userId } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  await prisma.careerArtifact.delete({ where: { id } });
  res.json({ ok: true });
});

// GET /p/:slug — public case study page (no auth)
export const publicArtifactRouter = Router();
publicArtifactRouter.get("/:slug", async (req, res) => {
  const artifact = await prisma.careerArtifact.findUnique({
    where: { slug: req.params.slug },
    include: { user: { select: { name: true, jobTitle: true } } },
  });

  if (!artifact || artifact.type !== "case_study") return res.status(404).send("Not found");

  await prisma.careerArtifact.update({ where: { id: artifact.id }, data: { viewCount: { increment: 1 } } });

  res.send(artifact.content);
});

async function generateArtifact(
  type: ArtifactType,
  evidenceSummary: string,
  targetRole?: string,
  companyContext?: string,
): Promise<string> {
  const roleContext = targetRole ? `Target role: ${targetRole}.` : "";

  const prompts: Record<ArtifactType, string> = {
    cv: `You are an expert tech career coach. Generate a polished, ATS-optimised CV in Markdown.
${roleContext}${companyContext}

Use ONLY the evidence provided. Write strong action-led bullet points that quantify impact.
Structure: Summary → Core Skills → Experience (evidence as bullets) → Notable Achievements.
Tailor language to match the target role and company if provided.`,

    interview_pack: `You are an expert tech career coach. Generate an interview preparation pack in Markdown.
${roleContext}${companyContext}

For each piece of evidence, write:
1. A STAR-format story (Situation, Task, Action, Result)
2. 2-3 interview questions this story answers
3. Follow-up questions to anticipate

Also include: 5 questions the candidate should ask the interviewer based on the role and company.`,

    case_study: `You are an expert tech career coach. Generate a compelling case study page in HTML.
${roleContext}${companyContext}

Create a well-structured HTML page with sections: Overview, Challenge, Approach, Outcome, Key Learnings.
Use the evidence provided. Make it professional and suitable for sharing publicly.`,

    skill_proof: `You are an expert tech career coach. Generate an AI & Technical Skills Proof document in Markdown.
${roleContext}${companyContext}

Focus specifically on evidence where aiInvolved=true, plus technical skills demonstrated.
Structure: AI Proficiency Summary → Specific AI Applications (with evidence) → Technical Skills → How This Applies to the Target Role.
This document proves the candidate is AI-native, not just AI-aware.`,

    outreach_message: `You are an expert tech career coach. Write a concise, personalised outreach message (LinkedIn DM or cold email) in Markdown.
${roleContext}${companyContext}

Keep it under 150 words. Lead with something specific about the company/role. Reference 1-2 achievements from the evidence that are directly relevant. End with a clear, low-friction ask (a 20-minute call).
Also write a shorter LinkedIn connection request version (under 300 characters).`,
  };

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: prompts[type],
    messages: [{ role: "user", content: `Evidence library:\n\n${evidenceSummary}` }],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
}

export default router;
