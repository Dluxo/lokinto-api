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

// ─── Public API ───────────────────────────────────────────────────────────────

export async function checkCompanyJobs(
  companyName: string,
  atsToken?: string,
  atsType?: string
): Promise<{ jobs: AtsJob[]; atsType: string; atsToken: string }> {
  const token = atsToken ?? companyToToken(companyName);

  // If we already know the ATS type, use it directly
  if (atsType === "greenhouse") {
    const jobs = await checkGreenhouse(token);
    return { jobs, atsType: "greenhouse", atsToken: token };
  }

  if (atsType === "lever") {
    const jobs = await checkLever(token);
    return { jobs, atsType: "lever", atsToken: token };
  }

  // Unknown — try both in parallel
  const [greenhouseJobs, leverJobs] = await Promise.all([
    checkGreenhouse(token),
    checkLever(token),
  ]);

  if (greenhouseJobs.length > 0) {
    return { jobs: greenhouseJobs, atsType: "greenhouse", atsToken: token };
  }

  if (leverJobs.length > 0) {
    return { jobs: leverJobs, atsType: "lever", atsToken: token };
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
