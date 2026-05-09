import PDFDocument from "pdfkit";
import { anthropic } from "../ai/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CVData {
  name: string;
  contact: string;
  summary: string;
  experience: {
    title: string;
    company: string;
    period: string;
    bullets: string[];
  }[];
  skills: string[];
  education: {
    degree: string;
    school: string;
    year: string;
  }[];
  keywords_added: string[];
  ats_score_estimate: string;
}

export interface GenerateCVOptions {
  cvText: string;
  jobDescription: string;
  jobTitle?: string;
  company?: string;
}

// ─── Claude ATS optimisation ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert CV writer and ATS (Applicant Tracking System) optimisation specialist with 10+ years of experience in the design industry.

Your task: rewrite the user's CV to maximise ATS match for a specific job posting.

RULES:
1. Keep ALL information truthful — only rephrase and reframe existing experience, never invent new roles or skills.
2. Mirror the exact language and keywords from the job description throughout the CV.
3. Front-load the most relevant experience and skills for this specific role.
4. Write a powerful 3-sentence summary that directly addresses the job requirements.
5. Rewrite bullet points to start with strong action verbs and include measurable outcomes where possible.
6. Ensure the skills section maps precisely to the required and preferred skills in the JD.
7. Return ONLY valid JSON — no markdown fences, no extra text.

Output this exact JSON shape:
{
  "name": "Full Name",
  "contact": "email | phone | location | linkedin",
  "summary": "3-sentence ATS-optimised professional summary targeting this specific role",
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "period": "Month Year – Month Year",
      "bullets": [
        "Action verb + task + outcome with relevant keywords from JD",
        "..."
      ]
    }
  ],
  "skills": ["Skill 1", "Skill 2", "..."],
  "education": [
    {
      "degree": "Degree Name",
      "school": "University Name",
      "year": "Year"
    }
  ],
  "keywords_added": ["list of ATS keywords naturally woven in"],
  "ats_score_estimate": "82%"
}`;

export async function tailorCV(options: GenerateCVOptions): Promise<CVData> {
  const { cvText, jobDescription, jobTitle, company } = options;

  const userMessage = [
    jobTitle || company
      ? `Target role: ${[jobTitle, company].filter(Boolean).join(" at ")}`
      : null,
    "--- JOB DESCRIPTION ---",
    jobDescription,
    "--- MY CURRENT CV ---",
    cvText,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 4096,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: "user", content: userMessage }],
  });

  const raw     = res.content[0].type === "text" ? res.content[0].text.trim() : "";
  const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();

  try {
    return JSON.parse(cleaned) as CVData;
  } catch {
    throw new Error("Claude returned malformed JSON — please try again.");
  }
}

// ─── PDF renderer ─────────────────────────────────────────────────────────────

const COLORS = {
  primary:   "#1a1a2e",
  accent:    "#4f46e5",
  muted:     "#6b7280",
  divider:   "#e5e7eb",
};

function px(n: number) { return n; }

export async function renderCVtoPDF(cv: CVData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 50,
      size:   "A4",
      info:   { Title: `${cv.name} — CV`, Author: cv.name },
    });

    const buffers: Buffer[] = [];
    doc.on("data",  (chunk) => buffers.push(chunk));
    doc.on("end",   () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const W = doc.page.width - 100; // usable width

    // ── Header ──────────────────────────────────────────────────────────────
    doc
      .font("Helvetica-Bold")
      .fontSize(22)
      .fillColor(COLORS.primary)
      .text(cv.name, { align: "left" });

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text(cv.contact, { align: "left" });

    doc.moveDown(0.4);
    doc
      .moveTo(50, doc.y)
      .lineTo(50 + W, doc.y)
      .strokeColor(COLORS.accent)
      .lineWidth(2)
      .stroke();
    doc.moveDown(0.6);

    // ── Section helper ───────────────────────────────────────────────────────
    function section(title: string) {
      doc.moveDown(0.3);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.accent)
        .text(title.toUpperCase(), { characterSpacing: 1 });
      doc
        .moveTo(50, doc.y + 2)
        .lineTo(50 + W, doc.y + 2)
        .strokeColor(COLORS.divider)
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.4);
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    section("Professional Summary");
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(COLORS.primary)
      .text(cv.summary, { lineGap: 3 });

    // ── Experience ───────────────────────────────────────────────────────────
    section("Experience");
    for (const job of cv.experience) {
      // Title + company row
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor(COLORS.primary)
        .text(job.title, { continued: true })
        .font("Helvetica")
        .fillColor(COLORS.muted)
        .text(`  •  ${job.company}`, { continued: true })
        .fillColor(COLORS.muted)
        .text(`  ${job.period}`, { align: "right" });

      doc.moveDown(0.2);

      for (const bullet of job.bullets) {
        doc
          .font("Helvetica")
          .fontSize(9.5)
          .fillColor(COLORS.primary)
          .text(`• ${bullet}`, {
            indent:  10,
            lineGap: 2,
          });
      }
      doc.moveDown(0.5);
    }

    // ── Skills ───────────────────────────────────────────────────────────────
    section("Skills");
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(COLORS.primary)
      .text(cv.skills.join("   •   "), { lineGap: 3 });

    // ── Education ────────────────────────────────────────────────────────────
    section("Education");
    for (const edu of cv.education) {
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor(COLORS.primary)
        .text(edu.degree, { continued: true })
        .font("Helvetica")
        .fillColor(COLORS.muted)
        .text(`  •  ${edu.school}  •  ${edu.year}`);
      doc.moveDown(0.3);
    }

    // ── Footer note ──────────────────────────────────────────────────────────
    doc.moveDown(1);
    doc
      .font("Helvetica-Oblique")
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(
        `ATS optimised for this role — estimated keyword match: ${cv.ats_score_estimate}`,
        { align: "center" }
      );

    doc.end();
  });
}

// ─── Fetch job description from a URL ────────────────────────────────────────

export async function fetchJobDescription(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 Lokinto/1.0" },
  });

  if (!res.ok) throw new Error(`Could not fetch URL (${res.status})`);

  const html = await res.text();

  // Strip tags and collapse whitespace — good enough for Claude to parse
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 8000); // cap at 8k chars
}
