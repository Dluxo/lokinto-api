// ─── Types ────────────────────────────────────────────────────────────────────

export interface Lead {
  name: string;
  role: string;
  company: string;
  email?: string;
  linkedIn?: string;
  confidence?: number;      // 0–100 from Hunter
  source: "hunter" | "apollo";
}

export interface LeadSearchParams {
  company: string;
  domain?: string;          // override domain inference (e.g. "linear.app")
  targetRoles?: string[];
  limit?: number;
}

// ─── Domain inference ─────────────────────────────────────────────────────────

function inferDomain(company: string): string {
  return company
    .toLowerCase()
    .replace(/\s+(inc|corp|ltd|llc|co\.?|company|technologies|tech|labs|group)\.?\s*$/i, "")
    .trim()
    .replace(/[^a-z0-9]/g, "")
    .concat(".com");
}

const DESIGN_ROLES = [
  "Head of Design",
  "VP of Design",
  "VP Design",
  "Design Director",
  "Design Manager",
  "Product Design Manager",
  "Lead Product Designer",
  "Senior Product Designer",
  "CPO",
  "Chief Design Officer",
  "Design Lead",
  "UX Lead",
  "UX Manager",
];

// ─── Hunter.io ────────────────────────────────────────────────────────────────

interface HunterEmail {
  value: string;
  confidence: number;
  first_name?: string;
  last_name?: string;
  position?: string;
  department?: string;
  linkedin?: string;
}

interface HunterResponse {
  data?: { emails: HunterEmail[] };
  errors?: { details: string }[];
}

async function searchHunter(params: LeadSearchParams): Promise<Lead[]> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return [];

  const domain = params.domain ?? inferDomain(params.company);

  const url = new URL("https://api.hunter.io/v2/domain-search");
  url.searchParams.set("domain", domain);
  url.searchParams.set("department", "design");
  url.searchParams.set("limit", String(params.limit ?? 10));
  url.searchParams.set("api_key", apiKey);

  console.log(`[leadFinder] hunter → domain=${domain}`);

  const res = await fetch(url.toString());
  if (!res.ok) {
    console.warn(`[leadFinder] Hunter error ${res.status} — skipping`);
    return [];
  }

  const data = (await res.json()) as HunterResponse;
  if (!data.data?.emails?.length) return [];

  return data.data.emails
    .filter((e) => e.first_name || e.last_name)
    .map((e) => ({
      name:       [e.first_name, e.last_name].filter(Boolean).join(" "),
      role:       e.position ?? "Designer",
      company:    params.company,
      email:      e.value,
      linkedIn:   e.linkedin ?? undefined,
      confidence: e.confidence,
      source:     "hunter" as const,
    }));
}

// ─── Apollo.io ────────────────────────────────────────────────────────────────

interface ApolloPerson {
  name: string;
  title?: string;
  organization_name?: string;
  linkedin_url?: string;
  email?: string;
}

interface ApolloResponse {
  people?: ApolloPerson[];
  error?: string;
}

async function searchApollo(params: LeadSearchParams): Promise<Lead[]> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return [];

  const body = {
    api_key: apiKey,
    q_organization_name: params.company,
    person_titles: params.targetRoles ?? DESIGN_ROLES,
    page: 1,
    per_page: params.limit ?? 5,
  };

  console.log(`[leadFinder] apollo → company=${params.company}`);

  const res = await fetch("https://api.apollo.io/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.warn(`[leadFinder] Apollo error ${res.status} — skipping`);
    return [];
  }

  const data = (await res.json()) as ApolloResponse;
  if (!data.people?.length) return [];

  return data.people.map((p) => ({
    name:     p.name,
    role:     p.title ?? "Designer",
    company:  p.organization_name ?? params.company,
    email:    p.email ?? undefined,
    linkedIn: p.linkedin_url ?? undefined,
    source:   "apollo" as const,
  }));
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function dedupeLeads(leads: Lead[]): Lead[] {
  const seen = new Set<string>();
  return leads.filter((l) => {
    const key = l.email
      ? l.email.toLowerCase()
      : `${l.name.toLowerCase()}|${l.company.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function findLeads(
  paramsOrCompany: string | LeadSearchParams
): Promise<Lead[]> {
  const params: LeadSearchParams =
    typeof paramsOrCompany === "string"
      ? { company: paramsOrCompany }
      : paramsOrCompany;

  const [hunter, apollo] = await Promise.allSettled([
    searchHunter(params),
    searchApollo(params),
  ]);

  const hunterLeads = hunter.status === "fulfilled" ? hunter.value : [];
  const apolloLeads = apollo.status === "fulfilled" ? apollo.value : [];

  if (hunter.status === "rejected") console.warn("[leadFinder] Hunter failed:", hunter.reason);
  if (apollo.status === "rejected") console.warn("[leadFinder] Apollo failed:", apollo.reason);

  const merged: Lead[] = [];
  const maxLen = Math.max(hunterLeads.length, apolloLeads.length);
  for (let i = 0; i < maxLen; i++) {
    if (hunterLeads[i]) merged.push(hunterLeads[i]);
    if (apolloLeads[i]) merged.push(apolloLeads[i]);
  }

  return dedupeLeads(merged).slice(0, 8);
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatLeads(leads: Lead[], company: string): string {
  if (leads.length === 0) {
    return [
      `😕 No design leads found at *${company}* right now.`,
      "",
      "_Make sure HUNTER\\_API\\_KEY or APOLLO\\_API\\_KEY is set in your .env_",
    ].join("\n");
  }

  const sourcesUsed = [...new Set(leads.map((l) => l.source))];
  const sourceLabel = sourcesUsed.map((s) => s === "hunter" ? "Hunter.io" : "Apollo").join(" + ");
  const header = `🎯 *${leads.length} design leads at ${company}* _(${sourceLabel})_:`;

  const lines = leads.map((lead, i) => {
    const confidence = lead.confidence ? ` _(${lead.confidence}%)_` : "";
    const email    = lead.email    ? `\n   📧 ${lead.email}${confidence}` : "";
    const linkedIn = lead.linkedIn ? `\n   🔗 ${lead.linkedIn}`           : "";
    const badge    = lead.source === "hunter" ? " _(Hunter)_" : " _(Apollo)_";

    return [
      `${i + 1}. *${lead.name}*${badge}`,
      `   🏷 ${lead.role} @ ${lead.company}${email}${linkedIn}`,
    ].join("\n");
  });

  return [header, "", ...lines].join("\n\n");
}
