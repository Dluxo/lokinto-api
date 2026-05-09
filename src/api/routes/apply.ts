import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { prisma } from "../../db/client";
import { sendPushToUser } from "../../notifications/push";

const router = Router();
router.use(requireAuth);

/**
 * POST /api/apply
 * Kicks off the apply workflow: creates an Application record in "processing" state,
 * then runs CV tailoring + cover letter generation in the background.
 * Returns immediately with the applicationId so the client can poll for status.
 */
router.post("/", async (req: AuthRequest, res: Response) => {
  const { jobTitle, company, url, salary, description } = req.body as {
    jobTitle?: string;
    company?: string;
    url?: string;
    salary?: string;
    description?: string;
  };

  if (!jobTitle || !company) {
    res.status(400).json({ error: "jobTitle and company are required" });
    return;
  }

  // Check user has a CV on file
  const cv = await prisma.userCV.findUnique({ where: { userId: req.userId } });
  if (!cv) {
    res.status(422).json({ error: "Upload your CV before applying" });
    return;
  }

  const application = await prisma.application.create({
    data: { userId: req.userId!, jobTitle, company, url, status: "processing" },
  });

  // Notify user immediately (DB + push)
  const processingTitle = `Tailoring your pack for ${company}`;
  const processingBody  = `Lokinto is crafting a personalised CV and cover letter for ${jobTitle} at ${company}`;
  await prisma.notification.create({
    data: {
      userId: req.userId!,
      type: "application_processing",
      title: processingTitle,
      body:  processingBody,
      metadata: { applicationId: application.id, jobTitle, company, url },
    },
  });
  sendPushToUser(req.userId!, {
    title: processingTitle,
    body:  processingBody,
    data:  { screen: "pipeline", applicationId: application.id },
  }).catch(() => {});

  // Fire-and-forget: run the actual apply workflow asynchronously
  setImmediate(async () => {
    try {
      const { generateAndSendCV } = await import("../../bot/router");

      // Pass structured params matching CommandParams — no Telegram context needed
      await generateAndSendCV(
        req.userId!,
        { job_title: jobTitle, company, url, keywords: description },
        description ?? "",
      );

      await prisma.application.update({
        where: { id: application.id },
        data: { status: "applied", appliedAt: new Date() },
      });

      const sentTitle = `Application sent — ${company}`;
      const sentBody  = `Your tailored pack for ${jobTitle} at ${company} is ready`;
      await prisma.notification.create({
        data: {
          userId: req.userId!,
          type: "application_sent",
          title: sentTitle,
          body:  sentBody,
          metadata: { applicationId: application.id },
        },
      });
      sendPushToUser(req.userId!, {
        title: sentTitle,
        body:  sentBody,
        data:  { screen: "pipeline", applicationId: application.id },
      }).catch(() => {});
    } catch (err) {
      console.error(`[apply] background workflow failed for application ${application.id}:`, err);
      await prisma.application.update({
        where: { id: application.id },
        data: { status: "error" },
      }).catch(() => {});
    }
  });

  res.status(202).json({ applicationId: application.id, status: "processing" });
});

// GET /api/apply/:id/status — poll application status
router.get("/:id/status", async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const application = await prisma.application.findFirst({
    where: { id, userId: req.userId },
    select: { id: true, status: true, jobTitle: true, company: true, appliedAt: true },
  });

  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  res.json(application);
});

export default router;
