import { ParsedCommand } from "../ai/parseCommand";
import { draftOutreach } from "../ai/draft";
import { searchJobs, formatJobResults, JobSearchParams } from "../actions/jobSearch";
import { findLeads, formatLeads, LeadSearchParams } from "../actions/leadFinder";
import { findCompanies, formatCompanies } from "../actions/companyFinder";
import { checkCompanyJobs } from "../actions/careerMonitor";
import { followCompany, unfollowCompany, getFollowedCompanies } from "../db/companies";
import { chat } from "../ai/chat";
import { setLastResults } from "./searchCache";
import { setLastLeads } from "./leadCache";
import { setLastCompanies } from "./companyCache";
import { getSavedJobs, getApplications, saveApplication, updateApplicationStatus } from "../db/jobs";
import { getSavedLeads } from "../db/leads";
import { getUserCV } from "../db/cv";
import { tailorCV, renderCVtoPDF, fetchJobDescription } from "../actions/cvGenerator";
import { getWorkItems, addWorkItem, savePortfolio, getUserPortfolios } from "../db/portfolio";
import { generatePortfolio, WorkItemData } from "../actions/portfolioGenerator";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bold(text: string): string {
  return `*${text}*`;
}

function buildJobQuery(params: ParsedCommand["params"]): string {
  return [
    params.seniority,
    params.job_title ?? "product designer",
    params.industry,
    params.keywords,
    // Only show location in query label if explicitly set; remote is always assumed
    params.location ? `in ${params.location}` : "remote worldwide",
  ]
    .filter(Boolean)
    .join(" ");
}

// ─── Intent Handlers ──────────────────────────────────────────────────────────

async function handleSearchJobs(
  chatId: number,
  params: ParsedCommand["params"],
  fallbackResponse: string
): Promise<string> {
  const searchParams: JobSearchParams = {
    jobTitle: params.job_title,
    location: params.location,
    remote: params.remote === "true",
    seniority: params.seniority,
    keywords: params.keywords,
    resultsPerPage: 5,
  };

  const humanQuery = buildJobQuery(params);

  try {
    const results = await searchJobs(searchParams);

    // Cache results so user can "save 1", "save 2 3" etc.
    setLastResults(chatId, results);

    const formatted = formatJobResults(results, humanQuery);

    if (results.length === 0) return formatted;

    return formatted + "\n\n💾 _Reply_ `save 1` _to bookmark a job, or_ `save 1 2 3` _to save multiple._";
  } catch (err: any) {
    console.error("[router] job search error:", err.message);
    return `⚠️ Job search failed: ${err.message}`;
  }
}

async function handleFindLeads(
  chatId: number,
  params: ParsedCommand["params"],
  fallbackResponse: string
): Promise<string> {
  const company = params.company ?? params.industry ?? params.keywords ?? "";

  if (!company) {
    return `${fallbackResponse}\n\nWhich company or industry do you want leads from? e.g. _"find leads at Figma"_ or _"find design leads at fintech startups"_`;
  }

  const searchParams: LeadSearchParams = {
    company,
    domain:      params.keywords?.includes(".") ? params.keywords : undefined,
    targetRoles: params.recipient_role ? [params.recipient_role] : undefined,
    limit:       5,
  };

  try {
    const leads = await findLeads(searchParams);

    // Cache so user can "save lead 1 2"
    setLastLeads(chatId, leads);

    const formatted = formatLeads(leads, company);

    if (leads.length === 0) return formatted;

    return formatted + "\n\n💾 _Reply_ `save lead 1` _to save a contact, or_ `save lead 1 2 3` _for multiple._";
  } catch (err: any) {
    console.error("[router] lead search error:", err.message);
    return `⚠️ Lead search failed: ${err.message}`;
  }
}

async function handleDraftOutreach(
  params: ParsedCommand["params"],
  fallbackResponse: string
): Promise<string> {
  const jobTitle = params.job_title ?? "Product Designer";
  const company = params.company ?? "the company";
  const senderName = params.recipient_name ?? "a product designer";

  // If we don't have enough context, ask for it
  if (!params.job_title && !params.company) {
    return `${fallbackResponse}\n\nCould you give me a bit more detail?\n• What role or company is this for?\n• Who are you reaching out to?`;
  }

  const draft = await draftOutreach({ jobTitle, company, senderName });

  return [
    `${bold("✍️ Outreach draft")} for ${bold(jobTitle)} @ ${bold(company)}:`,
    "",
    draft,
    "",
    "_Edit as needed — reply with any tweaks and I'll revise it._",
  ].join("\n");
}

async function handleResearchCompany(
  chatId: number,
  params: ParsedCommand["params"],
  userMessage: string
): Promise<string> {
  if (!params.company) {
    return "Which company would you like me to research? Just send me the name.";
  }
  // Delegate to Claude chat with context already embedded in the message
  return chat(chatId, userMessage);
}

// ─── Apply workflow ────────────────────────────────────────────────────────────
// Returns { cv, portfolio } so handler.ts can send the PDF and link together.

export interface ApplyResult {
  cv?: { pdf: Buffer; filename: string; atsScore: string; keywords: string[] };
  portfolioUrl?: string;
  application: { jobTitle: string; company: string };
  error?: never;
}

export interface ApplyError {
  error: string;
  cv?: never;
  portfolioUrl?: never;
  application?: never;
}

export async function runApplyWorkflow(
  userId: number,
  jobTitle: string,
  company: string,
  jobUrl?: string,
  jobDescription?: string,
): Promise<ApplyResult | ApplyError> {
  // 1. Record the application
  await saveApplication(userId, { jobTitle, company, url: jobUrl }).catch(() => {});

  // 2. Load what we have
  const [storedCV, items] = await Promise.all([
    getUserCV(userId),
    getWorkItems(userId),
  ]);

  // Build job description if not provided
  const jd = jobDescription ?? `Role: ${jobTitle}\nCompany: ${company}`;

  // 3. Run CV tailoring + portfolio generation in parallel
  const [cvResult, portfolioResult] = await Promise.allSettled([
    storedCV
      ? tailorCV({ cvText: storedCV.rawText, jobDescription: jd, jobTitle, company })
          .then(async (cvData) => {
            const pdf = await renderCVtoPDF(cvData);
            const safeName = company.replace(/[^a-z0-9]/gi, "_").toLowerCase();
            return { pdf, filename: `CV_${cvData.name.replace(/\s+/g, "_")}_${safeName}.pdf`, atsScore: cvData.ats_score_estimate, keywords: cvData.keywords_added };
          })
      : Promise.resolve(null),

    items.length > 0
      ? (async () => {
          const cv = storedCV;
          let ownerName = "Designer";
          let bio: string | undefined;
          if (cv?.rawText) {
            const firstLine = cv.rawText.split(/\n/).find((l) => l.trim().length > 0) ?? "";
            if (firstLine.length < 60 && !/\d/.test(firstLine)) ownerName = firstLine.trim();
            bio = cv.rawText.slice(0, 600);
          }
          const rawSlug = `${ownerName}-${company}-${Date.now()}`;
          const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
          const workItemData: WorkItemData[] = items.map((item) => ({
            id: item.id, title: item.title, description: item.description,
            role: item.role ?? undefined, tools: item.tools ?? undefined,
            outcome: item.outcome ?? undefined, imageUrl: item.imageUrl ?? undefined,
            projectUrl: item.projectUrl ?? undefined, tags: item.tags ?? undefined,
            sectionsJson: item.sectionsJson ?? undefined,
          }));
          const { generatePortfolio: gen } = await import("../actions/portfolioGenerator");
          const htmlContent = await gen({ ownerName, bio, jobTitle, company, jobDescription: jd, workItems: workItemData, slug });
          const { savePortfolio: savePf } = await import("../db/portfolio");
          await savePf(userId, { slug, jobTitle, company, htmlContent });
          const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
          return `${baseUrl}/p/${slug}`;
        })()
      : Promise.resolve(null),
  ]);

  const cv        = cvResult.status === "fulfilled" ? cvResult.value : null;
  const portfolio = portfolioResult.status === "fulfilled" ? portfolioResult.value : null;

  return {
    application:  { jobTitle, company },
    cv:           cv ?? undefined,
    portfolioUrl: portfolio ?? undefined,
  };
}

export async function handleUpdateStatus(
  userId: number,
  company: string,
  newStatus: string
): Promise<string> {
  const apps = await getApplications(userId);
  const match = apps.find((a) => a.company.toLowerCase().includes(company.toLowerCase()));

  if (!match) {
    return `⚠️ No application found for *${company}*. Check your pipeline with \`/status\`.`;
  }

  await updateApplicationStatus(userId, match.id, newStatus);

  const emoji: Record<string, string> = {
    interviewing: "🗣", offer: "🎉", rejected: "❌", applied: "📤", saved: "🔖",
  };

  return `${emoji[newStatus] ?? "✅"} *${match.jobTitle}* @ *${match.company}* marked as _${newStatus}_.`;
}

async function handleFindCompanies(
  chatId: number,
  params: ParsedCommand["params"],
  fallbackResponse: string
): Promise<string> {
  const industry = params.industry ?? params.keywords ?? params.job_title ?? "";

  if (!industry) {
    return `${fallbackResponse}\n\nWhich industry are you interested in? e.g. _"find fintech companies hiring designers"_`;
  }

  try {
    const companies = await findCompanies({
      industry,
      keywords: params.keywords !== params.industry ? params.keywords : undefined,
      limit: 20,
    });

    // Cache so user can "follow all" or "follow 1 2 3"
    setLastCompanies(chatId, companies);

    return formatCompanies(companies, industry);
  } catch (err: any) {
    console.error("[router] find companies error:", err.message);
    return `⚠️ Company search failed: ${err.message}`;
  }
}

async function handleBulkFollow(
  chatId: number,
  userId: number,
  params: ParsedCommand["params"],
  fallbackResponse: string
): Promise<string> {
  const industry = params.industry ?? params.keywords ?? "";

  if (!industry) {
    return `${fallbackResponse}\n\nWhich industry? e.g. _"follow top 20 fintech companies"_`;
  }

  const limit = Math.min(parseInt(params.limit ?? "20", 10) || 20, 30);
  const desiredRoles = params.keywords ?? "designer";

  // Step 1: find companies in this industry
  let companies;
  try {
    companies = await findCompanies({ industry, limit });
  } catch (err: any) {
    return `⚠️ Could not find companies in ${industry}: ${err.message}`;
  }

  if (companies.length === 0) {
    return `😔 No companies found hiring designers in *${industry}* right now. Try a different industry.`;
  }

  // Cache in case user wants to act on them later
  setLastCompanies(chatId, companies);

  // Step 2: for each company, detect ATS + follow — all in parallel
  const results = await Promise.allSettled(
    companies.map(async (c) => {
      const { atsType, atsToken } = await checkCompanyJobs(c.name).catch(() => ({
        atsType: "unknown",
        atsToken: c.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      }));
      return followCompany(userId, {
        name: c.name,
        atsType: atsType !== "unknown" ? atsType : undefined,
        atsToken: atsType !== "unknown" ? atsToken : undefined,
        desiredRoles,
      });
    })
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed    = results.length - succeeded;

  const companyList = companies
    .slice(0, 15)
    .map((c, i) => `${i + 1}. *${c.name}*`)
    .join("\n");

  const moreNote = companies.length > 15
    ? `\n_...and ${companies.length - 15} more_`
    : "";

  const failNote = failed > 0 ? `\n_${failed} could not be saved._` : "";

  return [
    `✅ *Now following ${succeeded} companies in ${industry}!*`,
    `I'll notify you when any post *${desiredRoles}* roles.`,
    "",
    companyList + moreNote + failNote,
    "",
    `💡 Send \`unfollow <name>\` to stop tracking any company.`,
  ].join("\n");
}

async function handleFollowCompany(
  userId: number,
  params: ParsedCommand["params"],
  fallbackResponse: string
): Promise<string> {
  const companyName = params.company;

  if (!companyName) {
    return `${fallbackResponse}\n\nWhich company would you like to follow? e.g. _"follow Figma"_`;
  }

  const desiredRoles = params.keywords ?? "designer";

  try {
    // Detect ATS type by trying to connect to the company's career page
    const { atsType, atsToken } = await checkCompanyJobs(companyName);

    await followCompany(userId, {
      name: companyName,
      atsType: atsType !== "unknown" ? atsType : undefined,
      atsToken: atsType !== "unknown" ? atsToken : undefined,
      desiredRoles,
    });

    return `✅ Now following *${companyName}*! I'll notify you when they post ${desiredRoles} roles.`;
  } catch (err: any) {
    console.error("[router] follow company error:", err.message);
    return `⚠️ Could not follow ${companyName}: ${err.message}`;
  }
}

async function handleUnfollowCompany(
  userId: number,
  params: ParsedCommand["params"],
  fallbackResponse: string
): Promise<string> {
  const companyName = params.company;

  if (!companyName) {
    return `${fallbackResponse}\n\nWhich company do you want to unfollow?`;
  }

  try {
    await unfollowCompany(userId, companyName);
    return `✅ Unfollowed *${companyName}*.`;
  } catch (err: any) {
    console.error("[router] unfollow company error:", err.message);
    return `⚠️ Could not unfollow ${companyName}: ${err.message}`;
  }
}

// ─── Portfolio Handlers ────────────────────────────────────────────────────────

async function handleListWorkItems(userId: number): Promise<string> {
  const items = await getWorkItems(userId);

  if (items.length === 0) {
    return [
      bold("📁 No work items yet."),
      "",
      "Add your case studies and projects so I can build tailored portfolios:",
      '_"Add work item: Redesigned onboarding at Acme — increased activation by 30%"_',
      '_"Add case study: Built design system for B2B SaaS at XYZ Corp"_',
    ].join("\n");
  }

  const lines: string[] = [bold(`📁 Your work items (${items.length}):`), ""];

  items.forEach((item, i) => {
    lines.push(`${i + 1}. *${item.title}*`);
    if (item.role) lines.push(`   Role: ${item.role}`);
    if (item.tools) lines.push(`   Tools: ${item.tools}`);
    if (item.outcome) lines.push(`   Outcome: ${item.outcome}`);
  });

  lines.push("");
  lines.push('_Send "generate portfolio for [role] at [company]" when ready._');

  return lines.join("\n");
}

async function handleAddWorkItem(
  userId: number,
  params: ParsedCommand["params"],
  userMessage: string
): Promise<string> {
  // Derive title from params.job_title (Claude may put it there) or parse from message
  let title = params.job_title ?? params.keywords ?? "";

  // If title looks like a full description, truncate it to a sensible heading
  if (!title || title.length > 80) {
    // Try to extract the first clause before a dash or colon
    const match = userMessage.match(/(?:add\s+(?:work\s+item|case\s+study|project)[:\s]+)?(.+?)(?:\s+[-—–]\s+|\s+at\s+|\s*:\s*|$)/i);
    title = match ? match[1].trim() : userMessage.slice(0, 60).trim();
  }

  // Build description from the full message minus command prefix
  const descriptionRaw = userMessage
    .replace(/^add\s+(?:work\s+item|case\s+study|project)[:\s]*/i, "")
    .trim();
  const description = descriptionRaw || title;

  // Extract outcome — text after dash/em-dash
  const outcomeMatch = userMessage.match(/[-—–]\s*(.+)$/);
  const outcome = params.outcome ?? (outcomeMatch ? outcomeMatch[1].trim() : undefined);

  try {
    await addWorkItem(userId, {
      title,
      description,
      role: params.recipient_role,
      tools: params.platform ?? params.keywords,
      outcome,
      projectUrl: params.url,
    });

    const allItems = await getWorkItems(userId);

    return [
      `✅ Work item added: *${title}*`,
      "",
      `You have ${allItems.length} item${allItems.length === 1 ? "" : "s"} in your portfolio.`,
      "",
      '_Send "generate portfolio for [role]" when ready._',
    ].join("\n");
  } catch (err: any) {
    console.error("[router] add work item error:", err.message);
    return `⚠️ Could not save work item: ${err.message}`;
  }
}

async function handleGeneratePortfolio(
  userId: number,
  params: ParsedCommand["params"],
  userMessage: string
): Promise<string> {
  // 1. Load work items
  const items = await getWorkItems(userId);

  if (items.length === 0) {
    return [
      "📁 *No work items found.*",
      "",
      "Add your case studies first so I can build a tailored portfolio:",
      '_"Add work item: Redesigned checkout at Stripe — increased conversion 23%"_',
      '_"Add case study: Built design system for fintech app"_',
      "",
      "Then send _\"generate portfolio for [role] at [company]\"_ again.",
    ].join("\n");
  }

  // 2. Load CV for owner name
  const cv = await getUserCV(userId);
  let ownerName = "Designer";
  let bio: string | undefined;

  if (cv?.rawText) {
    const firstLine = cv.rawText.split(/\n/).find((l) => l.trim().length > 0) ?? "";
    // Heuristic: first line is likely the name if it's short and has no numbers
    if (firstLine.length < 60 && !/\d/.test(firstLine)) {
      ownerName = firstLine.trim();
    }
    // Use a short excerpt as bio seed
    bio = cv.rawText.slice(0, 600);
  }

  // 3. Get job description
  const jobTitle = params.job_title ?? "Product Designer";
  const company = params.company ?? "the company";
  let jobDescription: string | undefined;

  const url = params.url ?? extractURL(userMessage);
  if (url) {
    try {
      jobDescription = await fetchJobDescription(url);
    } catch {
      // fall through — generate without JD
    }
  } else if (params.keywords && params.keywords.length > 80) {
    jobDescription = params.keywords;
  } else if (userMessage.length > 200) {
    jobDescription = userMessage;
  } else if (jobTitle || company) {
    jobDescription = [
      `Role: ${jobTitle}`,
      `Company: ${company}`,
      params.seniority ? `Level: ${params.seniority}` : "",
      params.keywords ? `Additional requirements: ${params.keywords}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // 4. Build slug early so project page URLs can be embedded in the portfolio
  const rawSlug = `${ownerName}-${company}-${Date.now()}`;
  const slug = rawSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

  // 5. Build WorkItemData array — include id and sectionsJson so project pages work
  const workItemData: WorkItemData[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    role: item.role ?? undefined,
    tools: item.tools ?? undefined,
    outcome: item.outcome ?? undefined,
    imageUrl: item.imageUrl ?? undefined,
    projectUrl: item.projectUrl ?? undefined,
    tags: item.tags ?? undefined,
    sectionsJson: item.sectionsJson ?? undefined,
  }));

  // 6. Generate HTML
  let htmlContent: string;
  try {
    htmlContent = await generatePortfolio({
      ownerName,
      bio,
      jobTitle,
      company,
      jobDescription,
      workItems: workItemData,
      slug,
    });
  } catch (err: any) {
    console.error("[router] portfolio generation error:", err.message);
    return `⚠️ Could not generate portfolio: ${err.message}`;
  }

  // 7. Save to DB
  try {
    await savePortfolio(userId, { slug, jobTitle, company, htmlContent });
  } catch (err: any) {
    console.error("[router] save portfolio error:", err.message);
    return `⚠️ Portfolio generated but could not be saved: ${err.message}`;
  }

  // 8. Build URL
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const portfolioUrl = `${baseUrl}/p/${slug}`;

  return [
    "🎨 *Portfolio generated!*",
    "",
    `🔗 ${portfolioUrl}`,
    "",
    `📊 Tailored for: *${jobTitle}* at *${company}*`,
    `📁 Work items featured: ${workItemData.length}`,
    "",
    "_Share this link in your application. The page is live now!_",
  ].join("\n");
}

async function handleStatus(userId: number): Promise<string> {
  const [savedJobs, savedLeads, applications, followedCompaniesData, workItemsData, portfoliosData] =
    await Promise.all([
      getSavedJobs(userId),
      getSavedLeads(userId),
      getApplications(userId),
      getFollowedCompanies(userId),
      getWorkItems(userId),
      getUserPortfolios(userId),
    ]);

  const lines: string[] = [bold("📊 Your pipeline"), ""];

  if (
    savedJobs.length === 0 &&
    savedLeads.length === 0 &&
    applications.length === 0 &&
    followedCompaniesData.length === 0 &&
    workItemsData.length === 0 &&
    portfoliosData.length === 0
  ) {
    lines.push("_Nothing saved yet._");
    lines.push("");
    lines.push("Try:");
    lines.push("• _Find me senior product design roles_");
    lines.push("• _Draft an outreach to Figma_");
    lines.push("• _Follow Figma for new design roles_");
    return lines.join("\n");
  }

  if (savedJobs.length > 0) {
    lines.push(bold(`🔖 Saved jobs (${savedJobs.length}):`));
    savedJobs.slice(0, 8).forEach((job: any, i: number) => {
      const salary = job.salary ? ` · ${job.salary}` : "";
      lines.push(`${i + 1}. *${job.title}* @ ${job.company}${salary}`);
      lines.push(`   🔗 ${job.url}`);
    });
    lines.push("");
  }

  if (savedLeads.length > 0) {
    lines.push(bold(`🎯 Saved leads (${savedLeads.length}):`));
    savedLeads.slice(0, 8).forEach((lead: any) => {
      const email = lead.email ? `\n   📧 ${lead.email}` : "";
      lines.push(`• *${lead.name}* — ${lead.role ?? "Designer"} @ ${lead.company}${email}`);
    });
    lines.push("");
  }

  if (applications.length > 0) {
    const statusEmoji: Record<string, string> = {
      saved: "🔖", applied: "📤", interviewing: "🗣", offer: "🎉", rejected: "❌",
    };
    lines.push(bold(`📋 Applications (${applications.length}):`));
    applications.slice(0, 8).forEach((app: any) => {
      const emoji = statusEmoji[app.status] ?? "•";
      lines.push(`${emoji} *${app.jobTitle}* @ ${app.company} — _${app.status}_`);
    });
    lines.push("");
  }

  if (followedCompaniesData.length > 0) {
    lines.push(bold(`🔔 Following (${followedCompaniesData.length} companies):`));
    followedCompaniesData.slice(0, 8).forEach((fc: any) => {
      lines.push(`• *${fc.name}* — watching for "${fc.desiredRoles}"`);
    });
    lines.push("");
  }

  if (workItemsData.length > 0) {
    lines.push(bold(`📁 Portfolio work items (${workItemsData.length}):`));
    workItemsData.slice(0, 5).forEach((item: any) => {
      lines.push(`• *${item.title}*${item.outcome ? ` — ${item.outcome}` : ""}`);
    });
    lines.push("");
  }

  if (portfoliosData.length > 0) {
    lines.push(bold(`🎨 Generated portfolios (${portfoliosData.length}):`));
    const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
    portfoliosData.slice(0, 5).forEach((p: any) => {
      lines.push(`• *${p.jobTitle ?? "Portfolio"}* @ ${p.company ?? "–"} — 👁 ${p.viewCount} views`);
      lines.push(`   🔗 ${baseUrl}/p/${p.slug}`);
    });
  }

  return lines.join("\n");
}

// handleGenerateCV is async and sends a file directly — returns status string
// The actual PDF sending is done in handler.ts via the exported generateAndSendCV helper
export async function generateAndSendCV(
  userId: number,
  params: ParsedCommand["params"],
  userMessage: string
): Promise<{ pdf: Buffer; filename: string; atsScore: string; keywords: string[] } | { error: string }> {
  // 1. Load stored CV
  const storedCV = await getUserCV(userId);
  if (!storedCV) {
    return {
      error:
        "📄 No CV on file yet.\n\nSend me your CV as a *PDF file* and I'll store it. Then ask me to tailor it for any role!",
    };
  }

  // 2. Get job description — from URL, from params, or from raw message
  let jobDescription = "";
  const url = params.url ?? extractURL(userMessage);

  if (url) {
    try {
      jobDescription = await fetchJobDescription(url);
    } catch (err: any) {
      return { error: `⚠️ Could not fetch that URL: ${err.message}` };
    }
  } else if (params.keywords && params.keywords.length > 80) {
    // Long keywords = user pasted the JD inline
    jobDescription = params.keywords;
  } else if (userMessage.length > 200) {
    // The full message looks like a pasted JD
    jobDescription = userMessage;
  } else if (params.job_title || params.company) {
    // Brief intent — Claude will infer a typical JD from title+company
    jobDescription = [
      `Role: ${params.job_title ?? "Product Designer"}`,
      params.company ? `Company: ${params.company}` : "",
      params.seniority ? `Level: ${params.seniority}` : "",
      params.keywords ? `Additional requirements: ${params.keywords}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } else {
    return {
      error:
        "Please give me the job description — paste it directly, share a URL, or say something like _\"tailor CV for Senior Designer at Figma\"_.",
    };
  }

  // 3. Tailor with Claude
  const cvData = await tailorCV({
    cvText: storedCV.rawText,
    jobDescription,
    jobTitle: params.job_title,
    company:  params.company,
  });

  // 4. Render PDF
  const pdf      = await renderCVtoPDF(cvData);
  const safeName = (params.company ?? "role").replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const filename = `CV_${cvData.name.replace(/\s+/g, "_")}_${safeName}.pdf`;

  return { pdf, filename, atsScore: cvData.ats_score_estimate, keywords: cvData.keywords_added };
}

function extractURL(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

function handleHelp(): string {
  return [
    bold("👋 Here's what I can do:"),
    "",
    "🔍 *Search jobs*",
    '  "Find senior product design roles in Berlin"',
    '  "Remote UX jobs at fintech startups"',
    "",
    "🎯 *Find leads*",
    '  "Find design leads at Series B startups"',
    '  "Who\'s hiring at Stripe or Linear?"',
    "",
    "✍️ *Draft outreach*",
    '  "Draft a cold message to the design team at Notion"',
    '  "Write a proposal for a freelance UI gig"',
    "",
    "🏢 *Research companies*",
    '  "Tell me about Figma\'s design culture"',
    '  "What does Vercel look for in designers?"',
    "",
    "📋 *Track applications*",
    '  "I applied to Airbnb for a product designer role"',
    "",
    "📊 *Check status*",
    '  "Show my pipeline"',
    "",
    "_Type /reset to start a fresh conversation._",
  ].join("\n");
}

// ─── Main Router ──────────────────────────────────────────────────────────────

export async function routeCommand(
  chatId: number,
  userId: number,
  userMessage: string,
  command: ParsedCommand
): Promise<string> {
  const { intent, params, response: fallback } = command;

  console.log(`[router] intent=${intent} params=${JSON.stringify(params)}`);

  switch (intent) {
    case "search_jobs":
      return handleSearchJobs(chatId, params, fallback);

    case "find_leads":
      return handleFindLeads(chatId, params, fallback);

    case "draft_outreach":
      return handleDraftOutreach(params, fallback);

    case "research_company":
      return handleResearchCompany(chatId, params, userMessage);

    case "apply_job":
      // Full workflow handled in handler.ts (needs to send PDF + URL)
      return "⏳ *Processing your application* — tailoring CV and portfolio...";

    case "update_status":
      return handleUpdateStatus(userId, params.company ?? "", params.keywords ?? "applied");

    case "status":
      return handleStatus(userId);

    case "find_companies":
      return handleFindCompanies(chatId, params, fallback);

    case "bulk_follow":
      return handleBulkFollow(chatId, userId, params, fallback);

    case "follow_company":
      return handleFollowCompany(userId, params, fallback);

    case "unfollow_company":
      return handleUnfollowCompany(userId, params, fallback);

    case "generate_cv":
      // Handled separately in handler.ts since it sends a file, not a text message
      return "⏳ Tailoring your CV — this takes about 15 seconds...";

    case "add_work_item":
      return handleAddWorkItem(userId, params, userMessage);

    case "generate_portfolio":
      return handleGeneratePortfolio(userId, params, userMessage);

    case "help":
      return handleHelp();

    case "general":
    default:
      return chat(chatId, userMessage);
  }
}
