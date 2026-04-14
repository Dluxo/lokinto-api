// ─── Types ────────────────────────────────────────────────────────────────────

export interface AtsJob {
  title: string;
  url: string;
  location?: string;
  department?: string;
  postedAt?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function companyToToken(companyName: string): string {
  return companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Greenhouse ───────────────────────────────────────────────────────────────

interface GreenhouseJob {
  title: string;
  absolute_url: string;
  location?: { name?: string };
  departments?: Array<{ name?: string }>;
  updated_at?: string;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

async function checkGreenhouse(token: string): Promise<AtsJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "GigBot/1.0" },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as GreenhouseResponse;
    const jobs: GreenhouseJob[] = data.jobs ?? [];

    return jobs.map((job) => ({
      title: job.title,
      url: job.absolute_url,
      location: job.location?.name,
      department: job.departments?.[0]?.name,
      postedAt: job.updated_at,
    }));
  } catch {
    return [];
  }
}

// ─── Lever ────────────────────────────────────────────────────────────────────

interface LeverPosting {
  text: string;
  hostedUrl: string;
  categories?: {
    location?: string;
    department?: string;
    team?: string;
  };
  createdAt?: number;
}

async function checkLever(token: string): Promise<AtsJob[]> {
  const url = `https://api.lever.co/v0/postings/${token}?mode=json`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "GigBot/1.0" },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as LeverPosting[];
    if (!Array.isArray(data)) return [];

    return data.map((posting) => ({
      title: posting.text,
      url: posting.hostedUrl,
      location: posting.categories?.location,
      department: posting.categories?.department ?? posting.categories?.team,
      postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : undefined,
    }));
  } catch {
    return [];
  }
}

// ─── Workable ─────────────────────────────────────────────────────────────────

interface WorkableJob {
  title: string;
  shortlink: string;
  location?: { city?: string; country?: string };
  department?: string;
  created_at?: string;
}

interface WorkableResponse {
  jobs: WorkableJob[];
}

async function checkWorkable(token: string): Promise<AtsJob[]> {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${token}/jobs`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "GigBot/1.0" } });
    if (!res.ok) return [];
    const data = (await res.json()) as WorkableResponse;
    return (data.jobs ?? []).map((job) => ({
      title: job.title,
      url: job.shortlink,
      location: [job.location?.city, job.location?.country].filter(Boolean).join(", "),
      department: job.department,
      postedAt: job.created_at,
    }));
  } catch { return []; }
}

// ─── Ashby ────────────────────────────────────────────────────────────────────

interface AshbyJob {
  title: string;
  jobUrl: string;
  locationName?: string;
  departmentName?: string;
  publishedAt?: string;
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

async function checkAshby(token: string): Promise<AtsJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "GigBot/1.0" } });
    if (!res.ok) return [];
    const data = (await res.json()) as AshbyResponse;
    return (data.jobs ?? []).map((job) => ({
      title: job.title,
      url: job.jobUrl,
      location: job.locationName,
      department: job.departmentName,
      postedAt: job.publishedAt,
    }));
  } catch { return []; }
}

// ─── Careers page scraper (fallback for custom pages) ────────────────────────

async function checkCareersPage(careersUrl: string, companyName: string): Promise<AtsJob[]> {
  try {
    const res = await fetch(careersUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GigBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];

    const html = await res.text();

    // Extract all links from the page
    const hrefPattern = /href=["']([^"']+)["'][^>]*>([^<]{3,80})</gi;
    const jobs: AtsJob[] = [];
    const seen = new Set<string>();
    let match;

    const designKeywords = ["design", "ux", "ui ", "product designer", "experience"];

    while ((match = hrefPattern.exec(html)) !== null) {
      const href  = match[1];
      const label = match[2].replace(/\s+/g, " ").trim();

      if (!label || label.length < 4) continue;

      const labelLower = label.toLowerCase();
      const isDesignRole = designKeywords.some((kw) => labelLower.includes(kw));
      if (!isDesignRole) continue;

      // Build absolute URL
      const absUrl = href.startsWith("http")
        ? href
        : href.startsWith("/")
          ? new URL(careersUrl).origin + href
          : careersUrl + "/" + href;

      if (seen.has(absUrl)) continue;
      seen.add(absUrl);

      jobs.push({ title: label, url: absUrl });
    }

    return jobs.slice(0, 10); // cap at 10 per company
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function checkCompanyJobs(
  companyName: string,
  atsToken?: string,
  atsType?: string,
  careersUrl?: string,
): Promise<{ jobs: AtsJob[]; atsType: string; atsToken: string }> {
  const token = atsToken ?? companyToToken(companyName);

  if (atsType === "greenhouse") {
    return { jobs: await checkGreenhouse(token), atsType: "greenhouse", atsToken: token };
  }
  if (atsType === "lever") {
    return { jobs: await checkLever(token), atsType: "lever", atsToken: token };
  }
  if (atsType === "workable") {
    return { jobs: await checkWorkable(token), atsType: "workable", atsToken: token };
  }
  if (atsType === "ashby") {
    return { jobs: await checkAshby(token), atsType: "ashby", atsToken: token };
  }
  if (atsType === "careers_page" && careersUrl) {
    return { jobs: await checkCareersPage(careersUrl, companyName), atsType: "careers_page", atsToken: token };
  }

  // Unknown — try all ATS APIs in parallel, fall back to careers page scrape
  const [ghJobs, lvJobs, wkJobs, abJobs] = await Promise.all([
    checkGreenhouse(token),
    checkLever(token),
    checkWorkable(token),
    checkAshby(token),
  ]);

  if (ghJobs.length > 0) return { jobs: ghJobs, atsType: "greenhouse", atsToken: token };
  if (lvJobs.length > 0) return { jobs: lvJobs, atsType: "lever",      atsToken: token };
  if (wkJobs.length > 0) return { jobs: wkJobs, atsType: "workable",   atsToken: token };
  if (abJobs.length > 0) return { jobs: abJobs, atsType: "ashby",      atsToken: token };

  if (careersUrl) {
    const pageJobs = await checkCareersPage(careersUrl, companyName);
    if (pageJobs.length > 0) return { jobs: pageJobs, atsType: "careers_page", atsToken: token };
  }

  return { jobs: [], atsType: "unknown", atsToken: token };
}

// ─── Filter ───────────────────────────────────────────────────────────────────

export function filterByDesiredRoles(jobs: AtsJob[], desiredRoles: string): AtsJob[] {
  const keywords = desiredRoles
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  if (keywords.length === 0) return jobs;

  return jobs.filter((job) =>
    keywords.some((kw) => job.title.toLowerCase().includes(kw))
  );
}
