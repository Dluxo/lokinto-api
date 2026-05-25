// ─── Types ────────────────────────────────────────────────────────────────────

export interface JobResult {
  title: string;
  company: string;
  location: string;
  url: string;
  salary?: string;
  jobType?: string;       // "full_time" | "contract" | "freelance" | "part_time"
  postedAt?: string;      // ISO date string
  tags?: string[];
  source?: "remotive" | "linkedin" | "himalayas";
}

export interface JobSearchParams {
  jobTitle?: string;
  location?: string;
  remote?: boolean;
  seniority?: string;
  keywords?: string;
  resultsPerPage?: number;
}

// ─── Remotive API (free, no key, remote-only, worldwide) ─────────────────────

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  tags: string[];
}

interface RemotiveResponse {
  jobs: RemotiveJob[];
  "job-count": number;
}

function daysAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function formatJobType(type: string): string {
  return (
    {
      full_time: "Full-time",
      contract: "Contract",
      freelance: "Freelance",
      part_time: "Part-time",
    }[type] ?? type
  );
}

/** Map a job title to the closest Remotive category */
function remotiveCategory(jobTitle?: string): string {
  const t = (jobTitle ?? "").toLowerCase();
  if (/data|analyst|scientist|ml|machine learning|ai engineer/.test(t)) return "Data";
  if (/design|ux|ui|product design|figma/.test(t))                       return "Design";
  if (/devops|sre|infra|platform|cloud|kubernetes|terraform/.test(t))    return "DevOps / Sysadmin";
  if (/product manager|pm|product ops/.test(t))                          return "Product";
  if (/marketing|growth|seo|content/.test(t))                            return "Marketing";
  if (/sales|account|business dev/.test(t))                              return "Sales";
  if (/finance|accounting|revenue/.test(t))                              return "Finance / Legal";
  if (/hr|people|recruiter|talent/.test(t))                              return "Human Resources";
  // default: software
  return "Software Development";
}

async function searchRemotive(params: JobSearchParams): Promise<JobResult[]> {
  const url = new URL("https://remotive.com/api/remote-jobs");

  const category = remotiveCategory(params.jobTitle);
  url.searchParams.set("category", category);
  url.searchParams.set("limit", String((params.resultsPerPage ?? 5) * 2)); // fetch more, filter after

  const searchTerms = [params.jobTitle, params.seniority, params.keywords]
    .filter(Boolean)
    .join(" ");

  if (searchTerms) url.searchParams.set("search", searchTerms);

  console.log(`[jobSearch] remotive category="${category}" search="${searchTerms}"`);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Remotive API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as RemotiveResponse;

  return data.jobs.map((job) => ({
    title: job.title,
    company: job.company_name,
    location: job.candidate_required_location || "Worldwide",
    url: job.url,
    salary: job.salary || undefined,
    jobType: job.job_type,
    postedAt: job.publication_date,
    tags: job.tags?.slice(0, 4),
    source: "remotive" as const,
  }));
}

// ─── JSearch via RapidAPI (LinkedIn + Indeed + Glassdoor) ────────────────────

interface JSearchJob {
  job_title: string;
  employer_name: string;
  job_city?: string;
  job_country?: string;
  job_apply_link: string;
  job_employment_type?: string;
  job_posted_at_timestamp?: number;
  job_min_salary?: number;
  job_max_salary?: number;
  job_salary_currency?: string;
  job_highlights?: { Qualifications?: string[] };
}

interface JSearchResponse {
  data: JSearchJob[];
}

async function searchJSearch(params: JobSearchParams): Promise<JobResult[]> {
  const apiKey = process.env.JSEARCH_API_KEY;
  if (!apiKey) return [];

  const query = [
    params.seniority,
    params.jobTitle ?? "Software Engineer",
    params.keywords,
    "remote",
  ]
    .filter(Boolean)
    .join(" ");

  const url = new URL("https://jsearch.p.rapidapi.com/search");
  url.searchParams.set("query", query);
  url.searchParams.set("num_pages", "1");
  url.searchParams.set("date_posted", "month");
  url.searchParams.set("remote_jobs_only", "true");

  console.log(`[jobSearch] jsearch query: "${query}"`);

  const res = await fetch(url.toString(), {
    headers: {
      "X-RapidAPI-Key": apiKey,
      "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
    },
  });

  if (!res.ok) {
    console.warn(`[jobSearch] JSearch error ${res.status} — skipping`);
    return [];
  }

  const data = (await res.json()) as JSearchResponse;
  const perSource = params.resultsPerPage ?? 5;

  return (data.data ?? []).slice(0, perSource).map((job) => {
    const location = [job.job_city, job.job_country].filter(Boolean).join(", ") || "Remote";
    const salary =
      job.job_min_salary && job.job_max_salary
        ? `${job.job_salary_currency ?? "$"}${Math.round(job.job_min_salary / 1000)}k–${Math.round(job.job_max_salary / 1000)}k`
        : undefined;
    const postedAt = job.job_posted_at_timestamp
      ? new Date(job.job_posted_at_timestamp * 1000).toISOString()
      : undefined;

    return {
      title: job.job_title,
      company: job.employer_name,
      location,
      url: job.job_apply_link,
      salary,
      jobType: job.job_employment_type?.toLowerCase(),
      postedAt,
      source: "linkedin" as const,
    };
  });
}

// ─── Himalayas API (free, no key, remote-first design jobs) ──────────────────

interface HimalayasJob {
  title: string;
  applicationUrl: string;
  jobType?: string;
  location?: string;
  publishedAt?: string;
  salary?: string;
  skills?: string[];
  company: {
    name: string;
  };
}

interface HimalayasResponse {
  jobs: HimalayasJob[];
  total?: number;
}

async function searchHimalayas(params: JobSearchParams): Promise<JobResult[]> {
  const query = [
    params.seniority,
    params.jobTitle ?? "Software Engineer",
    params.keywords,
  ]
    .filter(Boolean)
    .join(" ");

  const url = new URL("https://himalayas.app/jobs/api");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(params.resultsPerPage ?? 5));

  console.log(`[jobSearch] himalayas query: "${query}"`);

  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
  });

  if (!res.ok) {
    console.warn(`[jobSearch] Himalayas error ${res.status} — skipping`);
    return [];
  }

  const data = (await res.json()) as HimalayasResponse;

  return (data.jobs ?? [])
    .filter((job) => job.company?.name && job.applicationUrl)
    .map((job) => ({
      title: job.title,
      company: job.company.name,
      location: job.location || "Worldwide",
      url: job.applicationUrl,
      salary: job.salary || undefined,
      jobType: job.jobType,
      postedAt: job.publishedAt,
      tags: job.skills?.slice(0, 4),
      source: "himalayas" as const,
    }));
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function dedupe(jobs: JobResult[]): JobResult[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    const key = `${job.title.toLowerCase().trim()}|${job.company.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function searchJobs(
  queryOrParams: string | JobSearchParams
): Promise<JobResult[]> {
  const params: JobSearchParams =
    typeof queryOrParams === "string"
      ? { jobTitle: queryOrParams }
      : queryOrParams;

  // Run all three sources in parallel; JSearch is skipped if no API key
  const [remotive, jsearch, himalayas] = await Promise.allSettled([
    searchRemotive(params),
    searchJSearch(params),
    searchHimalayas(params),
  ]);

  const remotiveJobs  = remotive.status  === "fulfilled" ? remotive.value  : [];
  const jsearchJobs   = jsearch.status   === "fulfilled" ? jsearch.value   : [];
  const himalayasJobs = himalayas.status === "fulfilled" ? himalayas.value : [];

  if (remotive.status  === "rejected") console.warn("[jobSearch] Remotive failed:",  remotive.reason);
  if (jsearch.status   === "rejected") console.warn("[jobSearch] JSearch failed:",   jsearch.reason);
  if (himalayas.status === "rejected") console.warn("[jobSearch] Himalayas failed:", himalayas.reason);

  // Interleave all three sources so results feel diverse
  const merged: JobResult[] = [];
  const maxLen = Math.max(remotiveJobs.length, jsearchJobs.length, himalayasJobs.length);
  for (let i = 0; i < maxLen; i++) {
    if (remotiveJobs[i])  merged.push(remotiveJobs[i]);
    if (jsearchJobs[i])   merged.push(jsearchJobs[i]);
    if (himalayasJobs[i]) merged.push(himalayasJobs[i]);
  }

  return dedupe(merged).slice(0, 10);
}

export function formatJobResults(results: JobResult[], query: string): string {
  if (results.length === 0) {
    return [
      `😕 No remote design listings found for _"${query}"_ right now.`,
      "",
      'Try broadening the search — e.g. _"product designer"_ or _"UX designer"_.',
    ].join("\n");
  }

  const sourcesUsed = [...new Set(results.map((j) => j.source).filter(Boolean))];
  const sourceLabel = sourcesUsed.length > 1
    ? sourcesUsed.map((s) => s === "linkedin" ? "LinkedIn" : s === "himalayas" ? "Himalayas" : "Remotive").join(" + ")
    : "Remotive";
  const header = `🌍 *${results.length} remote design jobs — ${sourceLabel}:*`;

  const lines = results.map((job, i) => {
    const age = job.postedAt ? daysAgo(job.postedAt) : null;
    const type = job.jobType ? formatJobType(job.jobType) : null;
    const meta = [job.location, type, age].filter(Boolean).join(" · ");
    const salary = job.salary ? `\n   💰 ${job.salary}` : "";
    const tags =
      job.tags && job.tags.length > 0
        ? `\n   🏷 ${job.tags.join(", ")}`
        : "";
    const sourceBadge =
      job.source === "linkedin"  ? " _(LinkedIn)_"  :
      job.source === "himalayas" ? " _(Himalayas)_" : " _(Remotive)_";

    return [
      `${i + 1}. *${job.title}* @ ${job.company}${sourceBadge}`,
      `   📍 ${meta}${salary}${tags}`,
      `   🔗 ${job.url}`,
    ].join("\n");
  });

  return [header, "", ...lines].join("\n\n");
}
