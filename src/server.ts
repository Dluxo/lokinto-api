import dotenv from "dotenv";
dotenv.config({ override: true }); // override: true forces dotenv to overwrite any pre-set empty vars
import express, { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { startMonitor } from "./jobs/monitor";
import { startJobPoller } from "./jobs/jobPoller";
import { getPortfolioBySlug, incrementViewCount, getWorkItemById } from "./db/portfolio";
import { generateProjectPage } from "./actions/portfolioGenerator";
import { prisma } from "./db/client";
import apiRouter from "./api/index";

// Ensure uploads directory exists (Railway filesystem is writable but empty on first boot)
fs.mkdirSync(path.join(process.cwd(), "public", "uploads"), { recursive: true });

const app = express();
app.use(express.json());

// Serve uploaded case study images and static previews
app.use("/uploads", express.static(path.join(process.cwd(), "public", "uploads")));
app.use("/public", express.static(path.join(process.cwd(), "public")));

const PORT = process.env.PORT || 3000;


app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/p/:slug", async (req: Request, res: Response) => {
  try {
    const slug = req.params["slug"] as string;

    // Check new CareerArtifact case studies first
    const artifact = await prisma.careerArtifact.findUnique({ where: { slug } });
    if (artifact) {
      await prisma.careerArtifact.update({ where: { id: artifact.id }, data: { viewCount: { increment: 1 } } });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(artifact.content);
    }

    // Fall back to legacy Portfolio
    const portfolio = await getPortfolioBySlug(slug);
    if (!portfolio) {
      res.status(404).send("<h1>Portfolio not found</h1>");
      return;
    }
    await incrementViewCount(slug);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(portfolio.htmlContent);
  } catch (err) {
    console.error("[portfolio] serve error:", err);
    res.status(500).send("<h1>Error loading portfolio</h1>");
  }
});

app.get("/p/:slug/work/:workId", async (req: Request, res: Response) => {
  try {
    const workItem = await getWorkItemById(Number(req.params["workId"]));
    if (!workItem) { res.status(404).send("<h1>Project not found</h1>"); return; }
    const html = generateProjectPage({
      ...workItem,
      role:       workItem.role       ?? undefined,
      tools:      workItem.tools      ?? undefined,
      outcome:    workItem.outcome    ?? undefined,
      imageUrl:   workItem.imageUrl   ?? undefined,
      projectUrl: workItem.projectUrl ?? undefined,
      tags:       workItem.tags       ?? undefined,
    }, req.params["slug"] as string);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("[project] serve error:", err);
    res.status(500).send("<h1>Error loading project</h1>");
  }
});

app.use("/api", apiRouter);

app.listen(PORT, () => {
  console.log(`Lokinto webhook server listening on port ${PORT}`);
  startMonitor();
  startJobPoller();
});
