import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { anthropic } from "../../ai/client";
import { prisma } from "../../db/client";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

const router = Router();
router.use(requireAuth);

// In-memory conversation history per user (userId → MessageParam[])
const sessions = new Map<number, MessageParam[]>();

const BASE_PROMPT = `You are Lokinto, an AI career assistant specialised in helping product designers.
You help users:
- Understand job opportunities and what companies are looking for
- Tailor their CVs and cover letters for specific roles
- Manage their job search pipeline
- Prepare for interviews at design-led companies
- Build and present their portfolio

Be concise, warm, and actionable. Keep replies short — this is a mobile chat UI.
Don't use excessive markdown (no triple-backtick blocks). Use bullet points sparingly.
When the user asks about their pipeline, jobs, or applications — refer to their live data provided below.`;

async function buildSystemPrompt(userId: number): Promise<string> {
  const [user, cv, workItems, pipeline] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, jobTitle: true, experience: true, location: true },
    }).catch(() => null),

    prisma.userCV.findUnique({
      where: { userId },
      select: { rawText: true, filename: true },
    }).catch(() => null),

    prisma.workItem.findMany({
      where: { userId },
      select: { title: true, description: true, role: true, outcome: true, tags: true },
      orderBy: { order: "asc" },
      take: 10,
    }).catch(() => []),

    prisma.application.findMany({
      where: { userId },
      select: { jobTitle: true, company: true, status: true, appliedAt: true, notes: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }).catch(() => []),
  ]);

  let prompt = BASE_PROMPT;

  // User profile
  if (user) {
    prompt += `\n\n## User Profile
Name: ${user.name ?? "unknown"}
Current role: ${user.jobTitle ?? "not set"}
Experience: ${user.experience ?? "not set"}
Location: ${user.location ?? "not set"}`;
  }

  // CV summary (truncate to ~1000 chars to stay within context)
  if (cv?.rawText) {
    prompt += `\n\n## CV (${cv.filename})
${cv.rawText.slice(0, 1000)}${cv.rawText.length > 1000 ? "\n[... truncated]" : ""}`;
  }

  // Case studies / work items
  if (workItems.length > 0) {
    prompt += `\n\n## Portfolio Case Studies (${workItems.length} total)`;
    workItems.forEach((w, i) => {
      prompt += `\n${i + 1}. **${w.title}** — ${w.role ?? "designer"} | Outcome: ${w.outcome ?? "—"} | Tags: ${w.tags ?? "—"}`;
      if (w.description) prompt += `\n   ${w.description.slice(0, 120)}`;
    });
  }

  // Active pipeline
  if (pipeline.length > 0) {
    prompt += `\n\n## Application Pipeline (${pipeline.length} total)`;
    const byStatus: Record<string, Array<(typeof pipeline)[number]>> = {};
    pipeline.forEach(a => { (byStatus[a.status] ??= []).push(a); });
    for (const [status, apps] of Object.entries(byStatus)) {
      prompt += `\n${status.toUpperCase()}: ${apps.map(a => `${a.jobTitle} at ${a.company}`).join(", ")}`;
    }
  }

  return prompt;
}

// POST /api/chat — send a message, get a response
router.post("/", async (req: AuthRequest, res: Response) => {
  const { message } = req.body as { message?: string };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const userId = req.userId!;
  const systemPrompt = await buildSystemPrompt(userId);

  // Get / init session history
  if (!sessions.has(userId)) sessions.set(userId, []);
  const history = sessions.get(userId)!;
  history.push({ role: "user", content: message.trim() });

  // Keep last 40 messages (20 turns)
  const trimmed = history.slice(-40);

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: trimmed,
    });

    const reply =
      response.content[0].type === "text"
        ? response.content[0].text
        : "Sorry, I couldn't process that.";

    history.push({ role: "assistant", content: reply });
    res.json({ reply });
  } catch (err) {
    console.error("[chat] AI error:", err);
    res.status(502).json({ error: "AI service unavailable — please try again" });
  }
});

// DELETE /api/chat — clear session history
router.delete("/", (req: AuthRequest, res: Response) => {
  if (req.userId) sessions.delete(req.userId);
  res.json({ ok: true });
});

export default router;
