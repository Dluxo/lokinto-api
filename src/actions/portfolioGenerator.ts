import fs from "fs";
import path from "path";
import { anthropic } from "../ai/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkItemData {
  id?: number;          // DB id — used to build project page URL
  title: string;
  description: string;
  role?: string;
  tools?: string;
  outcome?: string;
  imageUrl?: string;    // comma-separated URLs stored in DB
  projectUrl?: string;
  tags?: string;
  sectionsJson?: string | null; // JSON array of content sections
}

export interface GeneratePortfolioOptions {
  ownerName: string;
  bio?: string;
  contact?: string;
  jobTitle?: string;
  company?: string;
  jobDescription?: string;
  workItems: WorkItemData[];
  slug?: string;       // portfolio slug — used to build /p/:slug/work/:id URLs
}

// ─── Portfolio data shape injected into the HTML template ─────────────────────

interface PortfolioData {
  name: string;
  tagline: string;
  bio: string;
  company: string;
  contact: string;
  contactMessage: string;
  skills: string[];
  workItems: Array<{
    title: string;
    description: string;
    role: string;
    tools: string;
    outcome: string;
    images: string[];
    projectUrl: string;
  }>;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert portfolio strategist for product designers.

Given a designer's work items and a target job, output a JSON object that will be rendered
into a portfolio page tailored to maximise match with the role.

Rules:
1. Select and ORDER the 3–5 most relevant work items for this specific role.
2. Rewrite each work item's description (2–3 sentences) using language from the job description.
3. Write a compelling tagline (one sentence) that directly addresses what this company is looking for.
4. Rewrite the bio (2–3 sentences) to position the designer as the ideal candidate.
5. Build a skills list from the job's required/preferred skills that the designer actually has.
6. Keep the contact message warm and direct.
7. Do NOT invent experience — only rephrase what exists.
8. Preserve all image URLs exactly as provided in the work items.

Output ONLY valid JSON matching this exact shape — no markdown, no extra text:
{
  "name": "string",
  "tagline": "string — one sentence, specific to this role",
  "bio": "string — 2-3 sentences, tailored",
  "company": "string — company name",
  "contact": "string — email or contact info",
  "contactMessage": "string — one sentence CTA",
  "skills": ["string", ...],
  "workItems": [
    {
      "title": "string",
      "shortIntro": "string — ONE sentence hook for the home card (max 15 words)",
      "description": "string — tailored 2-3 sentences for the project page",
      "role": "string",
      "tools": "string — comma separated",
      "outcome": "string — key metric or result",
      "thumbnail": "string — first image URL or empty string",
      "images": ["url", ...],
      "projectUrl": "string — will be filled in by the server"
    }
  ]
}`;

// ─── Generator ────────────────────────────────────────────────────────────────

export async function generatePortfolio(
  options: GeneratePortfolioOptions
): Promise<string> {
  const { ownerName, bio, contact, jobTitle, company, jobDescription, workItems, slug } = options;

  const itemsWithImages = workItems.map((item) => {
    const images = item.imageUrl
      ? item.imageUrl.split(",").map((u) => u.trim()).filter(Boolean)
      : [];
    return {
      ...item,
      thumbnail: images[0] ?? "",
      images,
    };
  });

  const userMessage = [
    `TARGET ROLE: ${jobTitle ?? "Product Designer"} at ${company ?? "the company"}`,
    "",
    "JOB DESCRIPTION:",
    jobDescription ?? "No JD provided — tailor for a typical senior product design role.",
    "",
    "DESIGNER INFO:",
    `Name: ${ownerName}`,
    `Bio: ${bio ?? "Experienced product designer"}`,
    `Contact: ${contact ?? ""}`,
    "",
    "WORK ITEMS:",
    JSON.stringify(itemsWithImages, null, 2),
  ].join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text.trim() : "{}";

  const json = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();

  let data: PortfolioData;
  try {
    data = JSON.parse(json) as PortfolioData;
  } catch {
    throw new Error("Claude returned invalid JSON for portfolio data");
  }

  // Inject project page URLs based on work item id and slug
  if (slug) {
    data.workItems = data.workItems.map((item, i) => ({
      ...item,
      projectUrl: workItems[i]?.id
        ? `/p/${slug}/work/${workItems[i].id}`
        : item.projectUrl ?? "",
    }));
  }

  // Read the user-editable template
  const templatePath = path.join(__dirname, "../templates/portfolio.html");
  const template = fs.readFileSync(templatePath, "utf-8");

  return template.replace("{{PORTFOLIO_DATA}}", JSON.stringify(data, null, 2));
}

// ─── Project page generator ───────────────────────────────────────────────────

export function generateProjectPage(
  workItem: WorkItemData,
  portfolioSlug: string
): string {
  const images = workItem.imageUrl
    ? workItem.imageUrl.split(",").map((u) => u.trim()).filter(Boolean)
    : [];

  // Parse sections if available; fall back to a simple paragraph
  let sections: unknown[] = [];
  if (workItem.sectionsJson) {
    try {
      sections = JSON.parse(workItem.sectionsJson);
    } catch {
      sections = [];
    }
  }
  // If no structured sections, create a simple fallback
  if (sections.length === 0 && workItem.description) {
    sections = [{ type: "paragraph", text: workItem.description }];
  }

  const data = {
    title:   workItem.title,
    role:    workItem.role    ?? "",
    tools:   workItem.tools   ?? "",
    outcome: workItem.outcome ?? "",
    tags:    workItem.tags    ?? "",
    images,   // full list of image URLs (referenced by sections via pageIndex)
    sections, // rich content sections for the project page
    backUrl: `/p/${portfolioSlug}`,
  };

  const templatePath = path.join(__dirname, "../templates/project.html");
  const template = fs.readFileSync(templatePath, "utf-8");
  return template.replace("{{PROJECT_DATA}}", JSON.stringify(data, null, 2));
}

// ─── Save case study page screenshots to disk ─────────────────────────────────

export function saveCaseStudyImages(
  userId: number,
  slug: string,
  pages: Array<{ pageNumber: number; png: Buffer }>,
  baseUrl: string
): string[] {
  // Save screenshots to a "pages" subfolder — archived for download, not for display
  const pagesDir = path.join(process.cwd(), "public", "uploads", String(userId), slug, "pages");
  fs.mkdirSync(pagesDir, { recursive: true });

  return pages.map((page) => {
    const filename = `page-${page.pageNumber}.png`;
    fs.writeFileSync(path.join(pagesDir, filename), page.png);
    return `${baseUrl}/uploads/${userId}/${slug}/pages/${filename}`;
  });
}

/**
 * Save a structured content markdown file for a case study.
 * This is the human-readable source used to render the work item page.
 */
export function saveCaseStudyContent(
  userId: number,
  slug: string,
  structured: {
    title: string;
    role?: string;
    tools?: string;
    outcome?: string;
    tags?: string;
    shortIntro?: string;
    sections?: Array<{ type: string; text?: string; items?: Array<{ value: string; label: string }> }>;
  }
): string {
  const dir = path.join(process.cwd(), "public", "uploads", String(userId), slug);
  fs.mkdirSync(dir, { recursive: true });

  const lines: string[] = [
    `# ${structured.title}`,
    "",
    `**Role:** ${structured.role ?? "—"}`,
    `**Tools:** ${structured.tools ?? "—"}`,
    `**Outcome:** ${structured.outcome ?? "—"}`,
    `**Tags:** ${structured.tags ?? "—"}`,
    "",
    "---",
    "",
  ];

  for (const section of structured.sections ?? []) {
    if (section.type === "heading") {
      lines.push(`## ${section.text}`, "");
    } else if (section.type === "paragraph") {
      lines.push(section.text ?? "", "");
    } else if (section.type === "stats") {
      for (const item of section.items ?? []) {
        lines.push(`- **${item.value}** — ${item.label}`);
      }
      lines.push("");
    }
  }

  const mdPath = path.join(dir, "content.md");
  fs.writeFileSync(mdPath, lines.join("\n"), "utf-8");
  return mdPath;
}
