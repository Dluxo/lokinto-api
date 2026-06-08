import { Router } from "express";
import { prisma } from "../../db/client";
import { requireAuth } from "../middleware/auth";
import { anthropic } from "../../ai/client";

const router = Router();
router.use(requireAuth);

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

// POST /api/evidence/bulk — save multiple items at once (used after CV review)
router.post("/bulk", async (req, res) => {
  const userId = (req as any).userId as number;
  const { items } = req.body;

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "items array required" });
  }

  try {
    const created = await prisma.$transaction(
      items.map((item: any) =>
        prisma.evidence.create({
          data: {
            userId,
            title:      item.title,
            summary:    item.summary,
            roleType:   item.roleType || "eng",
            impact:     item.impact || null,
            skills:     Array.isArray(item.skills) ? JSON.stringify(item.skills) : item.skills || null,
            aiInvolved: item.aiInvolved ?? false,
            periodFrom: item.periodFrom ? new Date(item.periodFrom) : null,
            periodTo:   item.periodTo   ? new Date(item.periodTo)   : null,
          },
        })
      )
    );
    res.status(201).json({ created: created.length, evidence: created });
  } catch (err) {
    console.error("[evidence/bulk]", err);
    res.status(500).json({ error: "Failed to save items" });
  }
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

// POST /api/evidence/craft — stateless AI drafting session
// Client sends the current draft + user message + conversation history.
// AI returns a reply and optionally an updated draft (appended as DRAFT_UPDATE:<json> on the last line).
router.post("/craft", async (req, res) => {
  const { draft, message, history = [] } = req.body as {
    draft: Record<string, any>;
    message: string;
    history: { role: "user" | "assistant"; content: string }[];
  };
  if (!draft || !message) {
    return res.status(400).json({ error: "draft and message required" });
  }

  const systemPrompt = `You are a career coach helping a professional craft a compelling work portfolio item.

Current draft:
${JSON.stringify(draft, null, 2)}

Rules:
1. Keep replies SHORT — 1-3 sentences max.
2. If the user asks you to change ANYTHING in the item, update it AND append on the very last line of your reply (no other text after it):
   DRAFT_UPDATE:{"title":"...","summary":"...","roleType":"eng|pm|data|design|ops|leadership","impact":"...or null","skills":["s1","s2"],"aiInvolved":false}
3. If nothing changed, do NOT include DRAFT_UPDATE.
4. Make the item compelling, metric-driven, and specific. Cut vague language.`;

  const messages = [
    ...history,
    { role: "user" as const, content: message },
  ];

  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const fullText = result.content[0].type === "text" ? result.content[0].text : "";

  // Parse optional DRAFT_UPDATE on last line
  const lines = fullText.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  let updatedDraft = draft;
  let reply = fullText;

  if (lastLine.startsWith("DRAFT_UPDATE:")) {
    try {
      updatedDraft = JSON.parse(lastLine.slice("DRAFT_UPDATE:".length).trim());
      reply = lines.slice(0, -1).join("\n").trim();
    } catch { /* keep original draft */ }
  }

  res.json({ reply, draft: updatedDraft });
});

// POST /api/evidence/structure — AI-structure raw notes without saving
router.post("/structure", async (req, res) => {
  const { rawNotes } = req.body;
  if (!rawNotes) return res.status(400).json({ error: "rawNotes required" });

  const structured = await structureRawNotes(rawNotes);
  res.json({ structured });
});

async function structureRawNotes(raw: string) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: `You are a career coach AI. Extract structured career evidence from raw notes.
Return ONLY valid JSON with these fields:
- title: string (short, action-led e.g. "Rebuilt search infrastructure cutting p99 latency by 60%")
- summary: string (2-3 sentences, what was done and why it mattered)
- roleType: "eng" | "pm" | "data" | "design" | "ops" | "leadership"
- impact: string (the key metric or outcome, e.g. "Reduced churn by 12%")
- skills: string[] (tools, technologies, methods used)
- aiInvolved: boolean (was AI/LLMs part of the work?)`,
    messages: [{ role: "user", content: raw }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "{}";
  try { return JSON.parse(text); } catch { return {}; }
}

export default router;
