import { Router, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";
import { extractTextFromPDF } from "../../actions/cvParser";

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

// GET /api/cv — CV metadata (no raw text)
router.get("/", async (req: AuthRequest, res: Response) => {
  const cv = await prisma.userCV.findUnique({
    where: { userId: req.userId },
    select: { id: true, filename: true, fileHash: true, uploadedAt: true, updatedAt: true },
  });
  res.json(cv ?? null);
});

// POST /api/cv/upload — upload + parse CV
router.post("/upload", upload.single("cv"), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "No file provided. Send as multipart field 'cv'." });
    return;
  }

  try {
    const buffer   = req.file.buffer;
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

    // Duplicate detection for this user
    const existing = await prisma.userCV.findFirst({ where: { fileHash, userId: req.userId } });
    if (existing) {
      res.status(409).json({ error: "This CV has already been uploaded", cv: existing });
      return;
    }

    const rawText = await extractTextFromPDF(buffer);

    const cv = await prisma.userCV.upsert({
      where: { userId: req.userId! },
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

// DELETE /api/cv — remove CV
router.delete("/", async (req: AuthRequest, res: Response) => {
  await prisma.userCV.deleteMany({ where: { userId: req.userId } });
  res.json({ ok: true });
});

export default router;
