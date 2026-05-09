import { anthropic } from "../ai/client";

export interface FormField {
  label: string;       // e.g. "Cover Letter", "Why do you want to work here?"
  type: string;        // "text" | "textarea" | "file" | "select" | "checkbox"
  required: boolean;
  hint?: string;       // any placeholder text or instructions
}

export interface ScrapedApplication {
  jobTitle: string;
  company:  string;
  applyUrl: string;
  atsType:  "greenhouse" | "lever" | "workable" | "ashby" | "unknown";
  fields:   FormField[];
}

// ─── Detect ATS from URL ───────────────────────────────────────────────────────

function detectATS(url: string): ScrapedApplication["atsType"] {
  if (url.includes("greenhouse.io"))   return "greenhouse";
  if (url.includes("lever.co"))        return "lever";
  if (url.includes("workable.com"))    return "workable";
  if (url.includes("ashbyhq.com"))     return "ashby";
  return "unknown";
}

function isJobBoard(url: string): boolean {
  return (
    url.includes("remotive.com") ||
    url.includes("himalayas.app") ||
    url.includes("linkedin.com/jobs") ||
    url.includes("indeed.com") ||
    url.includes("glassdoor.com")
  );
}

// ─── Fetch raw HTML ───────────────────────────────────────────────────────────

async function fetchHTML(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Lokinto/1.0)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Could not fetch ${url}: ${res.status}`);
  return res.text();
}

// ─── Resolve the real apply URL from a job board listing ─────────────────────
// Job boards (Remotive, Himalayas) show listings — we need the company's ATS URL

async function resolveApplyUrl(listingUrl: string): Promise<string> {
  try {
    const html = await fetchHTML(listingUrl);

    // Extract all href values
    const hrefPattern = /href=["']([^"']+)["']/gi;
    const hrefs: string[] = [];
    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
      hrefs.push(match[1]);
    }

    // Priority: known ATS domains first, then anything with "apply" in the path
    const atsDomains = ["greenhouse.io", "lever.co", "workable.com", "ashbyhq.com", "smartrecruiters.com", "jobvite.com", "icims.com", "taleo.net", "successfactors.com", "breezy.hr", "recruitee.com"];

    for (const href of hrefs) {
      const abs = href.startsWith("http") ? href : null;
      if (!abs) continue;
      if (atsDomains.some((d) => abs.includes(d))) return abs;
    }

    // Fallback: look for links with "apply" in the URL
    for (const href of hrefs) {
      const abs = href.startsWith("http") ? href : null;
      if (!abs) continue;
      if (abs.toLowerCase().includes("apply") && !abs.includes("remotive") && !abs.includes("himalayas")) return abs;
    }
  } catch {
    // If resolution fails, fall back to the original URL
  }

  return listingUrl;
}

// ─── Fetch and strip HTML to readable text ────────────────────────────────────

async function fetchPageText(url: string): Promise<string> {
  const html = await fetchHTML(url);

  // Strip scripts, styles, and HTML tags — keep readable text
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Truncate to avoid Claude token limits
  return text.slice(0, 8000);
}

// ─── Extract form fields via Claude ───────────────────────────────────────────

async function extractFields(pageText: string): Promise<FormField[]> {
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `This is the text content of a job application page. Identify all the form fields the applicant needs to fill in.

Page content:
${pageText}

Return ONLY a JSON array of fields — no markdown, no extra text:
[
  { "label": "Full Name", "type": "text", "required": true },
  { "label": "Cover Letter", "type": "textarea", "required": true, "hint": "max 500 words" },
  { "label": "CV / Resume", "type": "file", "required": true },
  { "label": "LinkedIn URL", "type": "text", "required": false }
]

Types: "text", "textarea", "file", "select", "checkbox"
Only include fields the applicant fills in — skip fields like "Job Title" or "Company" that are pre-filled.
If you cannot identify any fields, return an empty array [].`,
    }],
  });

  const raw = res.content[0].type === "text" ? res.content[0].text.trim() : "[]";
  const clean = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();

  try {
    return JSON.parse(clean) as FormField[];
  } catch {
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function scrapeApplicationPage(url: string, jobTitle: string, company: string): Promise<ScrapedApplication> {
  // Step 1 — if this is a job board listing, find the real company ATS URL
  let applyUrl = url;
  if (isJobBoard(url)) {
    applyUrl = await resolveApplyUrl(url);
    console.log(`[scraper] resolved ${url} → ${applyUrl}`);
  }

  // Step 2 — for known ATS, make sure we're on the /apply page
  const atsType = detectATS(applyUrl);
  if (atsType === "greenhouse" && !applyUrl.includes("/apply")) {
    applyUrl = applyUrl.endsWith("/") ? `${applyUrl}apply` : `${applyUrl}/apply`;
  }
  if (atsType === "lever" && !applyUrl.includes("/apply")) {
    applyUrl = applyUrl.endsWith("/") ? `${applyUrl}apply` : `${applyUrl}/apply`;
  }

  // Step 3 — scrape the actual form fields
  let fields: FormField[] = [];
  try {
    const pageText = await fetchPageText(applyUrl);
    fields = await extractFields(pageText);
  } catch {
    // Fallback — standard fields present on most applications
    fields = [
      { label: "Full Name",    type: "text",     required: true },
      { label: "Email",        type: "text",     required: true },
      { label: "Phone",        type: "text",     required: false },
      { label: "LinkedIn URL", type: "text",     required: false },
      { label: "Portfolio URL",type: "text",     required: false },
      { label: "Cover Letter", type: "textarea", required: true },
      { label: "CV / Resume",  type: "file",     required: true },
    ];
  }

  return { jobTitle, company, applyUrl, atsType, fields };
}
