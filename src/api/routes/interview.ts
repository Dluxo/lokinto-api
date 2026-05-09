/**
 * Interview Prep
 * POST /api/interview/:applicationId — generate prep pack for an interview
 * GET  /api/interview/:applicationId — fetch cached prep pack
 */
import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { anthropic } from "../../ai/client";
import { prisma } from "../../db/client";

const router = Router();
router.use(requireAuth);

export interface InterviewPrepPack {
  company: string;
  jobTitle: string;
  generatedAt: string;
  companyInsights: string[];
  likelyQuestions: Array<{ question: string; tip: string }>;
  caseStudiesToShowcase: Array<{ title: string; reason: string; talkingPoints: string[] }>;
  keyStrengths: string[];
  watchOuts: string[];
  openingStatement: string;
}

// GET /api/interview/:applicationId — return persisted pack if available
router.get("/:applicationId", async (req: AuthRequest, res: Response) => {
  const appId = Number(req.params["applicationId"]);
  const app = await prisma.application.findFirst({
    where: { id: appId, userId: req.userId },
    select: { prepPackJson: true },
  });
  if (!app) { res.status(404).json({ error: "Application not found" }); return; }
  if (!app.prepPackJson) { res.status(404).json({ error: "No prep pack generated yet" }); return; }
  res.json(JSON.parse(app.prepPackJson));
});

// POST /api/interview/:applicationId — generate prep pack
router.post("/:applicationId", async (req: AuthRequest, res: Response) => {
  const appId = Number(req.params["applicationId"]);
  const userId = req.userId!;

  // Fetch the application
  const application = await prisma.application.findFirst({
    where: { id: appId, userId },
  });
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  // Fetch user context
  const [user, cv, workItems] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, jobTitle: true, experience: true, location: true },
    }),
    prisma.userCV.findUnique({
      where: { userId },
      select: { rawText: true },
    }),
    prisma.workItem.findMany({
      where: { userId },
      select: { title: true, description: true, role: true, outcome: true, tags: true, tools: true },
      orderBy: { order: "asc" },
      take: 10,
    }),
  ]);

  const cvText = cv?.rawText?.slice(0, 2000) ?? "No CV uploaded yet.";
  const workItemsText = workItems.map((w, i) =>
    `${i + 1}. ${w.title} (role: ${w.role ?? "—"}, tools: ${w.tools ?? "—"}, outcome: ${w.outcome ?? "—"}, tags: ${w.tags ?? "—"})\n   ${w.description?.slice(0, 200) ?? ""}`
  ).join("\n");

  const prompt = `You are an expert interview coach for product designers.

Generate a personalised interview prep pack for the following:

## Candidate
Name: ${user?.name ?? "Designer"}
Current role: ${user?.jobTitle ?? "Product Designer"}
Experience: ${user?.experience ?? "not specified"}
Location: ${user?.location ?? "not specified"}

## Target Role
Company: ${application.company}
Job Title: ${application.jobTitle}
Job URL: ${application.url ?? "not provided"}
Notes: ${application.notes ?? "none"}

## Candidate's CV (excerpt)
${cvText}

## Portfolio Case Studies
${workItemsText || "No case studies uploaded yet."}

---

Return a JSON object with EXACTLY this structure:
{
  "company": "${application.company}",
  "jobTitle": "${application.jobTitle}",
  "generatedAt": "${new Date().toISOString()}",
  "companyInsights": ["3-5 bullet points about the company culture, design maturity, what they value in designers"],
  "likelyQuestions": [
    { "question": "Tell me about a time you had to...", "tip": "Focus on X from your background" }
  ],
  "caseStudiesToShowcase": [
    {
      "title": "Exact case study title from their portfolio",
      "reason": "Why this case study is relevant to this role",
      "talkingPoints": ["Key point to emphasise", "Metric to highlight", "Design decision to explain"]
    }
  ],
  "keyStrengths": ["3-4 strengths to lead with based on this role"],
  "watchOuts": ["1-2 potential gaps or weaknesses to address proactively"],
  "openingStatement": "A 2-3 sentence personalised elevator pitch for this specific role"
}

Include 5-7 likely questions, 2-3 case studies (or fewer if they have fewer). Be specific to the company and role — not generic.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in AI response");

    const pack: InterviewPrepPack = JSON.parse(jsonMatch[0]);

    await prisma.application.update({
      where: { id: appId },
      data: { prepPackJson: JSON.stringify(pack) },
    });

    res.json(pack);
  } catch (err) {
    console.error("[interview] AI error:", err);
    res.status(502).json({ error: "Failed to generate prep pack — please try again" });
  }
});

export default router;
