import { Router } from "express";
import { prisma } from "../../db/client";
import { requireAuth } from "../middleware/auth";
import OpenAI from "openai";

const router = Router();
router.use(requireAuth);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// GET /api/evidence
router.get("/", async (req, res) => {
  const userId = (req as any).userId as number;
  const { roleType } = req.query;

  const evidence = await prisma.evidence.findMany({
    where: { userId, ...(roleType ? { roleType: String(roleType) } : {}) },
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
  });

  res.json({ evidence });
});

// GET /api/evidence/:id
router.get("/:id", async (req, res) => {
  const userId = (req as any).userId as number;
  const id = Number(req.params.id);

  const item = await prisma.evidence.findFirst({ where: { id, userId } });
  if (!item) return res.status(404).json({ error: "Not found" });

  res.json({ evidence: item });
});

// POST /api/evidence — create from structured input or raw notes
router.post("/", async (req, res) => {
  const userId = (req as any).userId as number;
  const { title, summary, roleType, impact, skills, aiInvolved, periodFrom, periodTo, artifactsJson, rawNotes } = req.body;

  // If only rawNotes provided, use AI to structure it
  if (rawNotes && !title) {
    const structured = await structureRawNotes(rawNotes);
    const item = await prisma.evidence.create({
      data: {
        userId,
        title:      structured.title,
        summary:    structured.summary,
        roleType:   structured.roleType ?? "eng",
        impact:     structured.impact,
        skills:     structured.skills ? JSON.stringify(structured.skills) : null,
        aiInvolved: structured.aiInvolved ?? false,
        rawNotes,
      },
    });
    return res.status(201).json({ evidence: item });
  }

  if (!title || !summary || !roleType) {
    return res.status(400).json({ error: "title, summary, roleType required" });
  }

  const item = await prisma.evidence.create({
    data: {
      userId,
      title,
      summary,
      roleType,
      impact:       impact ?? null,
      skills:       Array.isArray(skills) ? JSON.stringify(skills) : skills ?? null,
      aiInvolved:   aiInvolved ?? false,
      periodFrom:   periodFrom ? new Date(periodFrom) : null,
      periodTo:     periodTo   ? new Date(periodTo)   : null,
      artifactsJson: artifactsJson ?? null,
      rawNotes:     rawNotes ?? null,
    },
  });

  res.status(201).json({ evidence: item });
});

// PUT /api/evidence/:id
router.put("/:id", async (req, res) => {
  const userId = (req as any).userId as number;
  const id = Number(req.params.id);

  const existing = await prisma.evidence.findFirst({ where: { id, userId } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const { title, summary, roleType, impact, skills, aiInvolved, periodFrom, periodTo, artifactsJson, rawNotes, order } = req.body;

  const updated = await prisma.evidence.update({
    where: { id },
    data: {
      title:        title       ?? existing.title,
      summary:      summary     ?? existing.summary,
      roleType:     roleType    ?? existing.roleType,
      impact:       impact      !== undefined ? impact      : existing.impact,
      skills:       skills      !== undefined ? (Array.isArray(skills) ? JSON.stringify(skills) : skills) : existing.skills,
      aiInvolved:   aiInvolved  !== undefined ? aiInvolved  : existing.aiInvolved,
      periodFrom:   periodFrom  !== undefined ? (periodFrom ? new Date(periodFrom) : null) : existing.periodFrom,
      periodTo:     periodTo    !== undefined ? (periodTo   ? new Date(periodTo)   : null) : existing.periodTo,
      artifactsJson: artifactsJson !== undefined ? artifactsJson : existing.artifactsJson,
      rawNotes:     rawNotes    !== undefined ? rawNotes    : existing.rawNotes,
      order:        order       !== undefined ? order       : existing.order,
    },
  });

  res.json({ evidence: updated });
});

// DELETE /api/evidence/:id
router.delete("/:id", async (req, res) => {
  const userId = (req as any).userId as number;
  const id = Number(req.params.id);

  const existing = await prisma.evidence.findFirst({ where: { id, userId } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  await prisma.evidence.delete({ where: { id } });
  res.json({ ok: true });
});

// POST /api/evidence/structure — AI-structure raw notes without saving
router.post("/structure", async (req, res) => {
  const { rawNotes } = req.body;
  if (!rawNotes) return res.status(400).json({ error: "rawNotes required" });

  const structured = await structureRawNotes(rawNotes);
  res.json({ structured });
});

async function structureRawNotes(raw: string) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a career coach AI. Extract structured career evidence from raw notes.
Return JSON with:
- title: string (short, action-led e.g. "Rebuilt search infrastructure cutting p99 latency by 60%")
- summary: string (2-3 sentences, what was done and why it mattered)
- roleType: "eng" | "pm" | "data" | "design" | "ops" | "leadership"
- impact: string (the key metric or outcome, e.g. "Reduced churn by 12%")
- skills: string[] (tools, technologies, methods used)
- aiInvolved: boolean (was AI/LLMs part of the work?)`,
      },
      { role: "user", content: raw },
    ],
  });

  return JSON.parse(completion.choices[0].message.content ?? "{}");
}

export default router;
