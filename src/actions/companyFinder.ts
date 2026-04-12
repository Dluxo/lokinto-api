// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompanyResult {
  name: string;
  industry?: string;
  jobCount: number;
  sampleRoles: string[];
  source: string;
}

export interface CompanySearchParams {
  industry: string;   // e.g. "fintech", "saas", "crypto"
  keywords?: string;  // additional filters
  limit?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

// ─── Remotive ─────────────────────────────────────────────────────────────────

interface RemotiveJob {
  company_name: string;
  title: string;
}

interface RemotiveResponse {
  jobs: RemotiveJob[];
}

async function searchRemotiveCompanies(
  params: CompanySearchParams
): Promise<CompanyResult[]> {
  const searchTerm = [params.industry, params.keywords].filter(Boolean).join("+");
  const url = `https://remotive.com/api/remote-jobs?category=Design&search=${encodeURIComponent(searchTerm)}&limit=50`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "GigBot/1.0" },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as RemotiveResponse;
    const jobs: RemotiveJob[] = data.jobs ?? [];

    // Group by company name
    const map = new Map<string, { count: number; roles: string[] }>();
    for (const job of jobs) {
      const key = normalizeName(job.company_name);
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        if (existing.roles.length < 3) existing.roles.push(job.title);
      } else {
        map.set(key, { count: 1, roles: [job.title] });
      }
    }

    const results: CompanyResult[] = [];
    for (const [key, value] of map.entries()) {
      // Recover original casing from first match
      const originalJob = jobs.find((j) => normalizeName(j.company_name) === key);
      results.push({
        name: originalJob?.company_name ?? key,
        jobCount: value.count,
        sampleRoles: value.roles,
        source: "Remotive",
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ─── JSearch ──────────────────────────────────────────────────────────────────

interface JSearchJob {
  employer_name: string;
  job_title: string;
}

interface JSearchResponse {
  data: JSearchJob[];
}

async function searchJSearchCompanies(
  params: CompanySearchParams
): Promise<CompanyResult[]> {
  const apiKey = process.env.JSEARCH_API_KEY;
  if (!apiKey) return [];

  const query = `product designer ${params.industry}${params.keywords ? " " + params.keywords : ""} remote`;
  const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&num_pages=1`;

  try {
    const res = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as JSearchResponse;
    const jobs: JSearchJob[] = data.data ?? [];

    // Group by employer name
    const map = new Map<string, { count: number; roles: string[] }>();
    for (const job of jobs) {
      if (!job.employer_name) continue;
      const key = normalizeName(job.employer_name);
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        if (existing.roles.length < 3) existing.roles.push(job.job_title);
      } else {
        map.set(key, { count: 1, roles: [job.job_title] });
      }
    }

    const results: CompanyResult[] = [];
    for (const [key, value] of map.entries()) {
      const originalJob = jobs.find((j) => normalizeName(j.employer_name) === key);
      results.push({
        name: originalJob?.employer_name ?? key,
        jobCount: value.count,
        sampleRoles: value.roles,
        source: "JSearch",
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function findCompanies(
  params: CompanySearchParams
): Promise<CompanyResult[]> {
  const limit = params.limit ?? 8;

  const [remotiveResults, jsearchResults] = await Promise.all([
    searchRemotiveCompanies(params),
    searchJSearchCompanies(params),
  ]);

  // Merge: dedupe by normalized company name, summing job counts
  const merged = new Map<string, CompanyResult>();

  for (const c of [...remotiveResults, ...jsearchResults]) {
    const key = normalizeName(c.name);
    const existing = merged.get(key);
    if (existing) {
      existing.jobCount += c.jobCount;
      // Merge sample roles (up to 3)
      for (const role of c.sampleRoles) {
        if (existing.sampleRoles.length < 3 && !existing.sampleRoles.includes(role)) {
          existing.sampleRoles.push(role);
        }
      }
      // Merge source labels if different
      if (!existing.source.includes(c.source)) {
        existing.source += `, ${c.source}`;
      }
    } else {
      merged.set(key, { ...c });
    }
  }

  // Sort by jobCount descending, take top N
  return Array.from(merged.values())
    .sort((a, b) => b.jobCount - a.jobCount)
    .slice(0, limit);
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatCompanies(companies: CompanyResult[], industry: string): string {
  if (companies.length === 0) {
    return `😔 No companies found hiring designers in *${industry}* right now. Try a different industry or keyword.`;
  }

  const lines: string[] = [
    `🏢 *${companies.length} companies hiring designers in ${industry}:*`,
    "",
  ];

  companies.forEach((c, i) => {
    const roleCount = c.jobCount === 1 ? "1 open design role" : `${c.jobCount} open design roles`;
    lines.push(`${i + 1}. *${c.name}* — ${roleCount}`);

    if (c.sampleRoles.length > 0) {
      const preview = c.sampleRoles.slice(0, 3).join(", ");
      const truncated = preview.length > 60 ? preview.slice(0, 57) + "..." : preview;
      lines.push(`   🏷 ${truncated}`);
    }

    lines.push("");
  });

  lines.push([
    `💡 _Follow shortcuts:_`,
    `• \`follow all\` — follow every company above`,
    `• \`follow 1 3 5\` — follow specific ones by number`,
    `• \`follow <name>\` — follow a single company`,
    `• \`follow top 20 ${"\u200b"}fintech companies\` — bulk follow by industry`,
  ].join("\n"));

  return lines.join("\n");
}
