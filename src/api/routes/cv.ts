import { Router, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";
import { anthropic } from "../../ai/client";
import { extractTextFromPDF, extractTextFromDocx } from "../../actions/cvParser";

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

async function extractText(buffer: Buffer, mimetype: string): Promise<string> {
  if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extractTextFromDocx(buffer);
  }
  return extractTextFromPDF(buffer);
}

// GET /api/cv — CV metadata (no raw text)
router.get("/", async (req: AuthRequest, res: Response) => {
  const cv = await prisma.userCV.findUnique({
    where: { userId: req.userId },
    select: { id: true, filename: true, fileHash: true, uploadedAt: true, updatedAt: true },
  });
  res.json(cv ?? null);
});

// POST /api/cv/upload — upload + parse CV (PDF or DOCX)
router.post("/upload", upload.single("cv"), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "No file provided. Send as multipart field 'cv'." });
    return;
  }

  try {
    const buffer   = req.file.buffer;
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

    const existing = await prisma.userCV.findFirst({ where: { fileHash, userId: req.userId } });
    if (existing) {
      res.status(409).json({ error: "This CV has already been uploaded", cv: existing });
      return;
    }

    const rawText = await extractText(buffer, req.file.mimetype);

    const cv = await prisma.userCV.upsert({
      where:  { userId: req.userId! },
      update: { filename: req.file.originalname, rawText, fileHash },
      create: { userId: req.userId!, filename: req.file.originalname, rawText, fileHash },
    });

    res.status(201).json({
      ok: true,
      cv: { id: cv.id, filename: cv.filename, uploadedAt: cv.uploadedAt },
    });
  } catch (err) {
    console.error("[cv/upload]", err);
    res.status(500).json({ error: "Failed to process CV" });
  }
});

// POST /api/cv/extract-evidence — parse stored CV with Claude → return draft items (NOT saved)
// The client reviews the items, then calls POST /api/evidence/bulk to confirm save.
router.post("/extract-evidence", async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  const cv = await prisma.userCV.findUnique({ where: { userId } });
  if (!cv) {
    res.status(404).json({ error: "No CV uploaded yet. Upload your CV first." });
    return;
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      system: `You are a career evidence extractor. Given a CV/resume, extract each distinct work achievement, project, or responsibility as a structured evidence item.

Return a JSON array only — no markdown, no explanation. Each item:
{
  "title": "short action-led title (max 80 chars)",
  "summary": "2-3 sentence description of what was done and why it mattered",
  "impact": "measurable result or metric if mentioned, otherwise null",
  "roleType": "eng|pm|data|design|ops|leadership",
  "skills": ["skill1", "skill2"],
  "aiInvolved": false,
  "periodFrom": "YYYY-MM-01 or null",
  "periodTo": "YYYY-MM-01 or null"
}

roleType rules: eng=software/infra, pm=product/strategy, data=analytics/ml, design=ux/visual, ops=operations/process, leadership=managing people/org.
Extract 3-15 items. Focus on achievements not job descriptions.`,
      messages: [{ role: "user", content: `CV text:\n\n${cv.rawText.slice(0, 12000)}` }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "[]";
    const items = JSON.parse(raw) as Array<{
      title: string;
      summary: string;
      impact: string | null;
      roleType: string;
      skills: string[];
      aiInvolved: boolean;
      periodFrom: string | null;
      periodTo: string | null;
    }>;

    // Return draft items — client reviews before calling /evidence/bulk to save
    res.json({ items });
  } catch (err) {
    console.error("[cv/extract-evidence]", err);
    res.status(500).json({ error: "Failed to extract evidence from CV" });
  }
});

// DELETE /api/cv — remove CV
router.delete("/", async (req: AuthRequest, res: Response) => {
  await prisma.userCV.deleteMany({ where: { userId: req.userId } });
  res.json({ ok: true });
});

export default router;
