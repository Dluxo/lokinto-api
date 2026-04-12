import { anthropic } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Intent =
  | "search_jobs"
  | "find_leads"
  | "draft_outreach"
  | "research_company"
  | "apply_job"
  | "update_status"
  | "status"
  | "find_companies"
  | "follow_company"
  | "unfollow_company"
  | "bulk_follow"
  | "generate_cv"
  | "add_work_item"
  | "generate_portfolio"
  | "help"
  | "general";

export interface CommandParams {
  job_title?: string;
  company?: string;
  location?: string;
  remote?: string;         // "true" | "false"
  seniority?: string;      // e.g. "senior", "mid", "junior"
  industry?: string;
  recipient_name?: string;
  recipient_role?: string;
  platform?: string;       // e.g. "LinkedIn", "email", "Upwork"
  budget?: string;
  keywords?: string;
  url?: string;
  limit?: string;
  [key: string]: string | undefined;
}

export interface ParsedCommand {
  intent: Intent;
  params: CommandParams;
  response: string;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a career intelligence agent for a product designer who is actively looking for:
- Remote-first, worldwide product design / UX design roles (mid to senior level)
- Freelance design gigs (UI/UX, product thinking, design systems) — remote preferred
- Contract opportunities with startups, scale-ups, and tech companies — remote only

IMPORTANT DEFAULTS (apply these unless the user explicitly says otherwise):
- remote = "true" by default for all job searches
- location = omit unless the user specifically names a city or country
- job_title = "product designer" if the user doesn't specify a design role

Your job is to classify the user's message into exactly one intent and extract all relevant parameters.

INTENT DEFINITIONS:
- search_jobs       → user wants to find job listings (full-time or contract)
- find_leads        → user wants to find companies, hiring managers, or people to pitch
- draft_outreach    → user wants to write a cold email, LinkedIn message, or proposal
- research_company  → user wants background info, culture, or funding info about a company
- apply_job         → user wants to submit or track a job application
- status            → user wants to see their pipeline, saved leads, or application status
- find_companies    → user wants to find companies hiring designers in a specific industry
- follow_company    → user wants to follow a single company's career page for job notifications
- unfollow_company  → user wants to stop following a company's career page
- bulk_follow       → user wants to follow MANY companies at once by industry (e.g. "follow top 20 fintech companies")
- generate_cv       → user wants to tailor/customise their CV for a specific job role or description
- add_work_item     → user wants to add a work/portfolio item (case study, project)
- generate_portfolio → user wants to generate a tailored portfolio page for a job role
- help              → user is confused, asking what the bot can do, or greeting
- general           → casual conversation or anything that doesn't fit the above

EXAMPLES FOR NEW INTENTS:
- "find fintech companies hiring designers" → find_companies, params.industry = "fintech"
- "show me saas companies that hire product designers" → find_companies, params.industry = "saas"
- "follow Figma" → follow_company, params.company = "Figma"
- "follow Stripe for senior designer roles" → follow_company, params.company = "Stripe", params.keywords = "senior designer"
- "track Notion careers" → follow_company, params.company = "Notion"
- "unfollow Figma" → unfollow_company, params.company = "Figma"
- "stop following Stripe" → unfollow_company, params.company = "Stripe"
- "follow top 20 fintech companies" → bulk_follow, params.industry = "fintech", params.limit = "20"
- "bulk follow saas startups" → bulk_follow, params.industry = "saas", params.limit = "20"
- "follow all crypto companies hiring designers" → bulk_follow, params.industry = "crypto", params.limit = "20"
- "follow 10 healthtech companies" → bulk_follow, params.industry = "healthtech", params.limit = "10"
- "tailor my CV for this job" → generate_cv, params.keywords = (any job description text the user pasted)
- "generate a CV for Senior Designer at Figma" → generate_cv, params.job_title = "Senior Designer", params.company = "Figma"
- "customise my resume for this role: [JD text]" → generate_cv, params.keywords = "[JD text]"
- "make my CV for https://..." → generate_cv, params.url = "https://..."
- "add work item: Redesigned checkout flow at Stripe — increased conversion 23%" → add_work_item
- "generate portfolio for Senior Designer at Figma" → generate_portfolio, params.job_title="Senior Designer", params.company="Figma"
- "create portfolio for this job: [URL or JD]" → generate_portfolio
- "mark Figma as interviewing" → update_status, params.company = "Figma", params.keywords = "interviewing"
- "Stripe rejected me" → update_status, params.company = "Stripe", params.keywords = "rejected"
- "got an offer from Linear" → update_status, params.company = "Linear", params.keywords = "offer"
- "update my Notion application to applied" → update_status, params.company = "Notion", params.keywords = "applied"

RULES:
1. Always respond with valid JSON — no markdown fences, no extra text.
2. Use this exact shape:
{
  "intent": "<one of the intents above>",
  "params": {
    "job_title": "...",       // design role — defaults to "product designer"
    "company": "...",         // if mentioned
    "location": "...",        // only if user explicitly names a place; omit otherwise
    "remote": "true",         // always "true" unless user says on-site/hybrid
    "seniority": "...",       // if mentioned (senior/mid/junior)
    "industry": "...",        // if mentioned
    "recipient_name": "...",  // for outreach: who to contact
    "recipient_role": "...",  // for outreach: their role
    "platform": "...",        // LinkedIn / email / Upwork / etc
    "budget": "...",          // for freelance: rate or budget
    "keywords": "..."         // any other relevant search terms
  },
  "response": "..."           // a short, natural, friendly reply (1–2 sentences max)
                              // confirm what you understood and what you'll do next
                              // speak in second person, be concise, no fluff
}
3. Only include params that are actually present or defaulted — omit the rest.
4. The "response" must always be present and feel like a smart assistant confirming the action.
5. If the intent is "help" or "general", params can be an empty object {}.
6. Always set remote="true" for search_jobs unless the user explicitly says on-site or hybrid.`;

// ─── Parser ───────────────────────────────────────────────────────────────────

export async function parseCommand(userMessage: string): Promise<ParsedCommand> {
  const raw = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  const text = raw.content[0].type === "text" ? raw.content[0].text.trim() : "";

  // Strip markdown code fences if Claude wraps the JSON anyway
  const cleaned = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as ParsedCommand;

    // Validate intent falls within known values, fall back to "general"
    const validIntents: Intent[] = [
      "search_jobs",
      "find_leads",
      "draft_outreach",
      "research_company",
      "apply_job",
      "update_status",
      "status",
      "find_companies",
      "follow_company",
      "unfollow_company",
      "bulk_follow",
      "generate_cv",
      "add_work_item",
      "generate_portfolio",
      "help",
      "general",
    ];

    if (!validIntents.includes(parsed.intent)) {
      parsed.intent = "general";
    }

    return parsed;
  } catch (err) {
    console.error("[parseCommand] Failed to parse Claude response:", text, err);
    return {
      intent: "general",
      params: {},
      response: "I didn't quite catch that — could you rephrase?",
    };
  }
}
