import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { anthropic } from "../../ai/client";
import { prisma } from "../../db/client";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

const router = Router();
router.use(requireAuth);

const BASE_PROMPT = `You are Lokinto, an AI career agent for tech professionals — engineers, PMs, designers, data scientists, product ops, and tech leaders.

You help users:
- Log and structure their daily work into career evidence
- Prepare for interviews with STAR stories from their own work
- Find and apply for relevant roles
- Generate tailored CVs, outreach messages, and case studies
- Build their professional portfolio

Be concise, warm, and actionable. Keep replies short — this is a mobile chat UI.
Don't use excessive markdown (no triple-backtick blocks). Use bullet points sparingly.

## IMPORTANT: Evidence Detection
When the user describes work they have done — a feature shipped, a metric improved, a project led, a problem solved — you MUST:
1. Acknowledge it naturally in your reply
2. Append a special tag at the very end of your response (after all text) in this exact format:
[SAVE_EVIDENCE:{"title":"Short title","summary":"One sentence summary","impact":"The measurable result if mentioned","roleType":"eng|pm|data|design|ops|leadership"}]

Only append this tag when the user is clearly describing their own past or recent work. Do NOT append it for hypothetical scenarios, questions, or general advice.

roleType must be one of: eng, pm, data, design, ops, leadership`;

async function buildSystemPrompt(userId: number): Promise<string> {
  const [user, evidence, pipeline] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, jobTitle: true, experience: true, location: true, targetRoles: true, currentLevel: true },
    }).catch(() => null),

    prisma.evidence.findMany({
      where: { userId },
      select: { title: true, summary: true, roleType: true, impact: true, skills: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    }).catch(() => []),

    prisma.application.findMany({
      where: { userId },
      select: { jobTitle: true, company: true, status: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    }).catch(() => []),
  ]);

  let prompt = BASE_PROMPT;

  if (user) {
    let targetRoles: string[] = [];
    try { targetRoles = user.targetRoles ? JSON.parse(user.targetRoles) : []; } catch {}
    prompt += `\n\n## User Profile
Name: ${user.name ?? "unknown"}
Current role: ${user.jobTitle ?? "not set"}
Level: ${user.currentLevel ?? "not set"}
Experience: ${user.experience ?? "not set"}
Location: ${user.location ?? "not set"}
Targeting: ${targetRoles.join(", ") || "not set"}`;
  }

  if (evidence.length > 0) {
    prompt += `\n\n## Work evidence logged (${evidence.length} items)`;
    evidence.forEach((e, i) => {
      prompt += `\n${i + 1}. [${e.roleType}] ${e.title}`;
      if (e.impact) prompt += ` — impact: ${e.impact}`;
      if (e.skills) {
        try { const s = JSON.parse(e.skills); if (s.length) prompt += ` | skills: ${s.slice(0, 3).join(", ")}`; } catch {}
      }
    });
  }

  if (pipeline.length > 0) {
    prompt += `\n\n## Applications`;
    const byStatus: Record<string, string[]> = {};
    pipeline.forEach(a => { (byStatus[a.status] ??= []).push(`${a.jobTitle} at ${a.company}`); });
    for (const [status, apps] of Object.entries(byStatus)) {
      prompt += `\n${status.toUpperCase()}: ${apps.join(", ")}`;
    }
  }

  return prompt;
}

// POST /api/chat — send a message, get a response + optional evidence to save
router.post("/", async (req: AuthRequest, res: Response) => {
  const { message } = req.body as { message?: string };
  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const userId = req.userId!;
  const systemPrompt = await buildSystemPrompt(userId);

  const session = await prisma.chatSession.findUnique({ where: { userId } });
  const history: MessageParam[] = session ? JSON.parse(session.messagesJson) : [];
  history.push({ role: "user", content: message.trim() });
  const trimmed = history.slice(-40);

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: trimmed,
    });

    const rawReply =
      response.content[0].type === "text"
        ? response.content[0].text
        : "Sorry, I couldn't process that.";

    // Extract [SAVE_EVIDENCE:{...}] tag if present
    const saveMatch = rawReply.match(/\[SAVE_EVIDENCE:(\{.*?\})\]/s);
    let savedEvidence: { id: number; title: string } | null = null;
    let reply = rawReply.replace(/\[SAVE_EVIDENCE:\{.*?\}\]/s, "").trim();

    if (saveMatch) {
      try {
        const data = JSON.parse(saveMatch[1]) as {
          title: string;
          summary: string;
          impact?: string;
          roleType?: string;
        };
        const created = await prisma.evidence.create({
          data: {
            userId,
            title: data.title,
            summary: data.summary || data.title,
            impact: data.impact || null,
            roleType: (data.roleType as any) || "eng",
            aiInvolved: false,
            skills: "[]",
          },
        });
        savedEvidence = { id: created.id, title: created.title };
        console.log(`[chat] Auto-saved evidence: "${created.title}" for user ${userId}`);
      } catch (e) {
        console.warn("[chat] Failed to parse/save evidence:", e);
      }
    }

    const updatedHistory = trimmed.concat([{ role: "assistant" as const, content: rawReply }]);
    await prisma.chatSession.upsert({
      where: { userId },
      update: { messagesJson: JSON.stringify(updatedHistory) },
      create: { userId, messagesJson: JSON.stringify(updatedHistory) },
    });

    res.json({ reply, savedEvidence });
  } catch (err) {
    console.error("[chat] AI error:", err);
    res.status(502).json({ error: "AI service unavailable — please try again" });
  }
});

// DELETE /api/chat — clear session history
router.delete("/", async (req: AuthRequest, res: Response) => {
  if (req.userId) {
    await prisma.chatSession.deleteMany({ where: { userId: req.userId } });
  }
  res.json({ ok: true });
});

export default router;
