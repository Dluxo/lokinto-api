/**
 * Job-source poller — pulls recent listings from remote job boards that expose
 * a free, no-auth public API, and upserts them into the JobPosting table.
 *
 * Only sources whose `adapter` is set on their JobSource row are polled.
 * Adding a new source = add a fetcher here + set its `adapter` value.
 */
import { prisma } from "../db/client";

const UA = "Mozilla/5.0 (compatible; LokintoJobPoller/1.0; +https://lokinto.com)";

// ─── Normalised shape every fetcher returns ─────────────────────────────────

export interface RawPosting {
  externalId?: string;
  title: string;
  company: string;
  location?: string;
  url: string;
  jobType?: string;
  salary?: string;
  tags?: string[];
  postedAt?: string; // ISO
}

type Fetcher = (limit: number) => Promise<RawPosting[]>;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── RemoteOK — https://remoteok.com/api (first array element is a legal notice) ─

const fetchRemoteOK: Fetcher = async (limit) => {
  const data = await getJson("https://remoteok.com/api");
  const jobs = Array.isArray(data) ? data.filter((j) => j && j.id && j.position) : [];
  return jobs.slice(0, limit).map((j: any) => ({
    externalId: String(j.id),
    title: j.position,
    company: j.company || "Unknown",
    location: j.location || "Remote",
    url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
    salary:
      j.salary_min && j.salary_max
        ? `$${Math.round(j.salary_min / 1000)}k–${Math.round(j.salary_max / 1000)}k`
        : undefined,
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 5) : undefined,
    postedAt: j.date || (j.epoch ? new Date(j.epoch * 1000).toISOString() : undefined),
  }));
};

// ─── Jobicy — https://jobicy.com/api/v2/remote-jobs ─────────────────────────

const fetchJobicy: Fetcher = async (limit) => {
  const data = await getJson(`https://jobicy.com/api/v2/remote-jobs?count=${limit}`);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((j: any) => ({
    externalId: String(j.id),
    title: j.jobTitle,
    company: j.companyName || "Unknown",
    location: j.jobGeo || "Anywhere",
    url: j.url,
    jobType: Array.isArray(j.jobType) ? j.jobType[0] : j.jobType,
    salary:
      j.annualSalaryMin && j.annualSalaryMax
        ? `${j.salaryCurrency || "$"}${Math.round(j.annualSalaryMin / 1000)}k–${Math.round(j.annualSalaryMax / 1000)}k`
        : undefined,
    tags: Array.isArray(j.jobIndustry) ? j.jobIndustry.slice(0, 5) : undefined,
    postedAt: j.pubDate || undefined,
  }));
};

// ─── Remotive — https://remotive.com/api/remote-jobs ────────────────────────

const fetchRemotive: Fetcher = async (limit) => {
  const data = await getJson(`https://remotive.com/api/remote-jobs?limit=${limit}`);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((j: any) => ({
    externalId: String(j.id),
    title: j.title,
    company: j.company_name || "Unknown",
    location: j.candidate_required_location || "Worldwide",
    url: j.url,
    jobType: j.job_type,
    salary: j.salary || undefined,
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 5) : undefined,
    postedAt: j.publication_date || undefined,
  }));
};

// ─── Working Nomads — https://www.workingnomads.com/api/exposed_jobs/ ────────

const fetchWorkingNomads: Fetcher = async (limit) => {
  const data = await getJson("https://www.workingnomads.com/api/exposed_jobs/");
  const jobs = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.slice(0, limit).map((j: any) => ({
    externalId: j.id ? String(j.id) : undefined,
    title: j.title,
    company: j.company_name || j.company || "Unknown",
    location: j.location || "Remote",
    url: j.url,
    jobType: j.category_name || undefined,
    tags: typeof j.tags === "string" ? j.tags.split(",").map((t: string) => t.trim()).slice(0, 5) : undefined,
    postedAt: j.pub_date || j.created || undefined,
  }));
};

// ─── Registry ───────────────────────────────────────────────────────────────

const FETCHERS: Record<string, Fetcher> = {
  remoteok:      fetchRemoteOK,
  jobicy:        fetchJobicy,
  remotive:      fetchRemotive,
  workingnomads: fetchWorkingNomads,
};

export const POLLABLE_ADAPTERS = Object.keys(FETCHERS);

// ─── Poll a single source ───────────────────────────────────────────────────

export interface PollResult {
  source: string;
  adapter: string;
  fetched: number;
  created: number;
  error?: string;
}

export async function pollSource(
  source: { id: number; name: string; adapter: string | null },
  limit = 50,
): Promise<PollResult> {
  const adapter = source.adapter ?? "";
  const fetcher = FETCHERS[adapter];
  if (!fetcher) {
    return { source: source.name, adapter, fetched: 0, created: 0, error: "no fetcher" };
  }

  try {
    const raw = (await fetcher(limit)).filter((p) => p.url && p.title);

    // Pre-fetch existing URLs for this source to count genuinely-new postings
    const existing = await prisma.jobPosting.findMany({
      where: { sourceId: source.id, url: { in: raw.map((p) => p.url) } },
      select: { url: true },
    });
    const existingUrls = new Set(existing.map((e) => e.url));
    let created = 0;

    for (const p of raw) {
      await prisma.jobPosting.upsert({
        where: { sourceId_url: { sourceId: source.id, url: p.url } },
        create: {
          sourceId:   source.id,
          externalId: p.externalId ?? null,
          title:      p.title,
          company:    p.company,
          location:   p.location ?? null,
          url:        p.url,
          jobType:    p.jobType ?? null,
          salary:     p.salary ?? null,
          tags:       p.tags ? JSON.stringify(p.tags) : null,
          postedAt:   p.postedAt ? new Date(p.postedAt) : null,
        },
        update: {
          // Refresh volatile fields; keep original fetchedAt
          title:    p.title,
          company:  p.company,
          location: p.location ?? null,
          jobType:  p.jobType ?? null,
          salary:   p.salary ?? null,
          tags:     p.tags ? JSON.stringify(p.tags) : null,
          postedAt: p.postedAt ? new Date(p.postedAt) : null,
        },
      });
      if (!existingUrls.has(p.url)) created++;
    }

    await prisma.jobSource.update({
      where: { id: source.id },
      data: { lastCheckedAt: new Date(), lastJobCount: raw.length },
    });

    return { source: source.name, adapter, fetched: raw.length, created };
  } catch (err: any) {
    return { source: source.name, adapter, fetched: 0, created: 0, error: err?.message ?? "failed" };
  }
}

// ─── Poll all active, adapter-backed sources ────────────────────────────────

export async function pollAllSources(limit = 50): Promise<PollResult[]> {
  const sources = await prisma.jobSource.findMany({
    where: { active: true, adapter: { not: null } },
  });

  console.log(`[jobPoller] polling ${sources.length} source(s)…`);
  const results: PollResult[] = [];
  for (const s of sources) {
    const r = await pollSource(s, limit);
    results.push(r);
    console.log(
      `[jobPoller] ${r.source}: fetched ${r.fetched}, new ${r.created}${r.error ? ` (error: ${r.error})` : ""}`,
    );
  }
  return results;
}
