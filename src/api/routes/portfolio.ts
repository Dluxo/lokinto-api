import { Router, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype === "application/pdf");
  },
});

// GET /api/portfolio — all portfolios + work items for the user
router.get("/", async (req: AuthRequest, res: Response) => {
  const [portfolios, workItems] = await Promise.all([
    prisma.portfolio.findMany({
      where: { userId: req.userId },
      select: {
        id: true, slug: true, jobTitle: true,
        company: true, viewCount: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.workItem.findMany({
      where: { userId: req.userId },
      select: {
        id: true, title: true, description: true, role: true,
        tools: true, outcome: true, tags: true, order: true,
        imageUrl: true, createdAt: true,
      },
      orderBy: { order: "asc" },
    }),
  ]);

  res.json({ portfolios, workItems });
});

// GET /api/portfolio/:id — single work item with full sections
router.get("/work/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const item = await prisma.workItem.findFirst({
    where: { id, userId: req.userId },
  });
  if (!item) { res.status(404).json({ error: "Work item not found" }); return; }

  res.json({
    ...item,
    sections: item.sectionsJson ? JSON.parse(item.sectionsJson) : [],
  });
});

// POST /api/portfolio/case-study — upload a case study PDF for AI extraction
router.post("/case-study", upload.single("pdf"), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "No PDF uploaded. Send as multipart field 'pdf'." });
    return;
  }

  try {
    const buffer   = req.file.buffer;
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

    const duplicate = await prisma.workItem.findFirst({ where: { fileHash, userId: req.userId } });
    if (duplicate) {
      res.status(409).json({
        error: "This case study has already been uploaded",
        workItemId: duplicate.id,
      });
      return;
    }

    // Fire-and-forget: run the same PDF extraction pipeline used by the Telegram bot
    setImmediate(async () => {
      try {
        const { processCaseStudy } = await import("../../actions/portfolioGenerator");
        await processCaseStudy(req.userId!, buffer, req.file!.originalname, fileHash);
      } catch (err) {
        console.error("[portfolio/case-study] background extraction failed:", err);
      }
    });

    res.status(202).json({
      ok: true,
      message: "Case study received — Lokinto is extracting content in the background",
      fileHash,
    });
  } catch (err) {
    console.error("[portfolio/case-study]", err);
    res.status(500).json({ error: "Failed to queue case study" });
  }
});

// DELETE /api/portfolio/work/:id — remove a work item
router.delete("/work/:id", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  await prisma.workItem.deleteMany({ where: { id, userId: req.userId } });
  res.json({ ok: true });
});

export default router;
