import TelegramBot from "node-telegram-bot-api";
import { clearHistory } from "../ai/chat";
import { parseCommand } from "../ai/parseCommand";
import { routeCommand } from "./router";
import { upsertUser } from "../db/users";
import { saveJob } from "../db/jobs";
import { saveLead } from "../db/leads";
import { saveUserCV } from "../db/cv";
import { getLastResults } from "./searchCache";
import { getLastLeads } from "./leadCache";
import { getLastCompanies } from "./companyCache";
import { followCompany } from "../db/companies";
import { checkCompanyJobs } from "../actions/careerMonitor";
import crypto from "crypto";
import { extractTextFromPDF, extractPDFPages, downloadTelegramFile } from "../actions/cvParser";
import { saveCaseStudyImages, saveCaseStudyContent } from "../actions/portfolioGenerator";
import { addWorkItem, getWorkItems, findWorkItemByHash } from "../db/portfolio";
import { findCVByHash } from "../db/cv";
import { generateAndSendCV, runApplyWorkflow, handleUpdateStatus, ApplyResult } from "./router";
import { getAlert } from "./alertCache";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const bot = new TelegramBot(token, { polling: false });

// Tracks chats waiting for a case study PDF upload (cleared after upload or 3 min)
const pendingCaseStudy = new Map<number, ReturnType<typeof setTimeout>>();

export function setPendingCaseStudy(chatId: number): void {
  const existing = pendingCaseStudy.get(chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => pendingCaseStudy.delete(chatId), 3 * 60 * 1000);
  pendingCaseStudy.set(chatId, timer);
}

// Holds a PDF buffer while we wait for the user to choose CV or Case Study
const pendingPDF = new Map<number, { buffer: Buffer; filename: string; userId: number; fileHash: string; timer: ReturnType<typeof setTimeout> }>();

// ─── Save handler ─────────────────────────────────────────────────────────────

const SAVE_PATTERN        = /^save\s+([\d\s,]+)$/i;
const SAVE_LEAD_PATTERN   = /^save\s+lead\s+([\d\s,]+)$/i;
const FOLLOW_ALL_PATTERN  = /^follow\s+all$/i;
const FOLLOW_NUMS_PATTERN = /^follow\s+(\d[\d\s,]*)$/i;
const APPLY_NUM_PATTERN   = /^apply\s+(\d+)$/i;
const MARK_STATUS_PATTERN = /^mark\s+(.+?)\s+as\s+(interviewing|rejected|offer|applied|saved)$/i;

async function handleSave(chatId: number, userId: number, text: string): Promise<void> {
  const match = text.match(SAVE_PATTERN);
  if (!match) return;

  const indices = match[1]
    .split(/[\s,]+/)
    .map((n) => parseInt(n, 10) - 1)       // convert 1-based to 0-based
    .filter((n) => !isNaN(n) && n >= 0);

  const lastResults = getLastResults(chatId);

  if (lastResults.length === 0) {
    await bot.sendMessage(chatId, "⚠️ No recent search results to save. Run a job search first.", { parse_mode: "Markdown" });
    return;
  }

  const toSave = indices
    .map((i) => lastResults[i])
    .filter(Boolean);

  if (toSave.length === 0) {
    await bot.sendMessage(chatId, `⚠️ Invalid number — pick between 1 and ${lastResults.length}.`, { parse_mode: "Markdown" });
    return;
  }

  const results = await Promise.allSettled(toSave.map((job) => saveJob(userId, job)));

  const saved   = results.filter((r) => r.status === "fulfilled").length;
  const already = toSave.length - saved;

  const lines = toSave.map((job, i) => `• *${job.title}* @ ${job.company}`);
  const summary = already > 0
    ? `_${already} already in your pipeline._`
    : "";

  await bot.sendMessage(
    chatId,
    [`✅ *${saved} job${saved !== 1 ? "s" : ""} saved to your pipeline:*`, "", ...lines, "", summary].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleSaveLead(chatId: number, userId: number, text: string): Promise<void> {
  const match = text.match(SAVE_LEAD_PATTERN);
  if (!match) return;

  const indices = match[1]
    .split(/[\s,]+/)
    .map((n) => parseInt(n, 10) - 1)
    .filter((n) => !isNaN(n) && n >= 0);

  const lastLeads = getLastLeads(chatId);

  if (lastLeads.length === 0) {
    await bot.sendMessage(chatId, "⚠️ No recent lead results to save. Run a lead search first.", { parse_mode: "Markdown" });
    return;
  }

  const toSave = indices.map((i) => lastLeads[i]).filter(Boolean);

  if (toSave.length === 0) {
    await bot.sendMessage(chatId, `⚠️ Invalid number — pick between 1 and ${lastLeads.length}.`, { parse_mode: "Markdown" });
    return;
  }

  const results = await Promise.allSettled(toSave.map((lead) => saveLead(userId, lead)));
  const saved   = results.filter((r) => r.status === "fulfilled").length;
  const already = toSave.length - saved;

  const lines = toSave.map((lead) => `• *${lead.name}* — ${lead.role} @ ${lead.company}`);
  const summary = already > 0 ? `_${already} already saved._` : "";

  await bot.sendMessage(
    chatId,
    [`✅ *${saved} lead${saved !== 1 ? "s" : ""} saved:*`, "", ...lines, "", summary].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleFollowFromCache(
  chatId: number,
  userId: number,
  indices: number[] | "all"
): Promise<void> {
  const companies = getLastCompanies(chatId);

  if (companies.length === 0) {
    await bot.sendMessage(
      chatId,
      "⚠️ No recent company search to follow from. Try _\"find fintech companies\"_ first.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const toFollow = indices === "all"
    ? companies
    : indices.map((i) => companies[i]).filter(Boolean);

  if (toFollow.length === 0) {
    await bot.sendMessage(
      chatId,
      `⚠️ Invalid number — pick between 1 and ${companies.length}.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await bot.sendChatAction(chatId, "typing").catch(() => {});

  // Detect ATS + follow all in parallel
  const results = await Promise.allSettled(
    toFollow.map(async (c) => {
      const { atsType, atsToken } = await checkCompanyJobs(c.name).catch(() => ({
        atsType: "unknown",
        atsToken: c.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      }));
      return followCompany(userId, {
        name: c.name,
        atsType: atsType !== "unknown" ? atsType : undefined,
        atsToken: atsType !== "unknown" ? atsToken : undefined,
        desiredRoles: "designer",
      });
    })
  );

  const saved  = results.filter((r) => r.status === "fulfilled").length;
  const lines  = toFollow.map((c) => `• *${c.name}*`);

  await bot.sendMessage(
    chatId,
    [
      `✅ *Now following ${saved} compan${saved !== 1 ? "ies" : "y"}:*`,
      "",
      ...lines,
      "",
      `_I'll notify you when any post designer roles._`,
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

// ─── Main handler ─────────────────────────────────────────────────────────────

// ─── Apply workflow sender ─────────────────────────────────────────────────────

async function sendApplyWorkflow(
  chatId: number,
  userId: number,
  jobTitle: string,
  company: string,
  jobUrl?: string,
  jobDescription?: string
): Promise<void> {
  await bot.sendMessage(
    chatId,
    `🚀 *Applying to ${jobTitle} at ${company}*\n\n_Preparing your application pack — CV, portfolio, and pre-filled answers..._`,
    { parse_mode: "Markdown" }
  );
  await bot.sendChatAction(chatId, "upload_document").catch(() => {});

  // Run CV/portfolio generation + form scraping in parallel
  const { scrapeApplicationPage } = await import("../actions/applicationScraper");
  const { generateApplicationAnswers, formatApplicationPack } = await import("../actions/applicationWriter");
  const { getUserCV } = await import("../db/cv");
  const { getWorkItems } = await import("../db/portfolio");

  const [result, cv, workItems] = await Promise.all([
    runApplyWorkflow(userId, jobTitle, company, jobUrl, jobDescription),
    getUserCV(userId),
    getWorkItems(userId),
  ]);

  if ("error" in result && result.error) {
    await bot.sendMessage(chatId, `⚠️ ${result.error}`, { parse_mode: "Markdown" });
    return;
  }

  const appInfo = (result as ApplyResult).application;

  // Send tailored CV PDF
  if (result.cv) {
    const { pdf, filename, atsScore, keywords } = result.cv;
    await bot.sendDocument(chatId, pdf, {}, { filename, contentType: "application/pdf" });
    await bot.sendMessage(
      chatId,
      [
        `📄 *Tailored CV ready*`,
        `📊 ATS match estimate: *${atsScore}*`,
        `🏷 Keywords added: ${keywords.slice(0, 8).join(", ")}`,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  }

  // Send portfolio link
  if (result.portfolioUrl) {
    await bot.sendMessage(
      chatId,
      `🎨 *Tailored portfolio:* ${result.portfolioUrl}\n_Include this link in your application._`,
      { parse_mode: "Markdown" }
    );
  }

  // Scrape application form + generate pre-filled answers
  if (jobUrl && cv?.rawText) {
    try {
      await bot.sendChatAction(chatId, "typing").catch(() => {});

      const workItemsSummary = workItems
        .slice(0, 3)
        .map((w) => `• ${w.title}${w.outcome ? ` — ${w.outcome}` : ""}`)
        .join("\n");

      const [scraped, answers] = await Promise.all([
        scrapeApplicationPage(jobUrl, jobTitle, company),
        generateApplicationAnswers(
          [],  // will be replaced below after scrape
          cv.rawText,
          jobTitle,
          company,
          result.portfolioUrl,
          workItemsSummary,
        ),
      ]);

      // Re-generate with actual fields from scrape
      const fullAnswers = scraped.fields.length > 0
        ? await generateApplicationAnswers(
            scraped.fields,
            cv.rawText,
            jobTitle,
            company,
            result.portfolioUrl,
            workItemsSummary,
          )
        : answers;

      // Get the application ID we just created
      const { getApplications } = await import("../db/jobs");
      const apps = await getApplications(userId);
      const latestApp = apps[0]; // most recent

      const pack = formatApplicationPack(
        jobTitle,
        company,
        scraped.applyUrl,
        fullAnswers,
        latestApp?.id ?? 0,
      );

      // Send each message in the pack
      for (const msg of pack.messages) {
        await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(() =>
          bot.sendMessage(chatId, msg)
        );
      }

      // Send the "I Applied" button
      await bot.sendMessage(
        chatId,
        `_Once you've submitted, tap the button below to update your pipeline._`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ I Applied",  callback_data: pack.callbackData },
              { text: "⏳ Not yet",   callback_data: "apply_later" },
            ]],
          },
        }
      );
    } catch (err: any) {
      console.error("[apply] scrape error:", err.message);
      // Don't block — just skip the application pack if scraping fails
      await bot.sendMessage(
        chatId,
        `🔗 *Apply directly:* ${jobUrl}\n\n_Tap below once submitted._`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ I Applied", callback_data: `applied:${0}` },
              { text: "⏳ Not yet",  callback_data: "apply_later" },
            ]],
          },
        }
      );
    }
  } else {
    // No URL — just show status update prompt
    const { getApplications } = await import("../db/jobs");
    const apps = await getApplications(userId);
    const latestApp = apps[0];

    await bot.sendMessage(
      chatId,
      `💡 Once you've submitted your application, tap below to track it.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ I Applied", callback_data: `applied:${latestApp?.id ?? 0}` },
            { text: "⏳ Not yet",  callback_data: "apply_later" },
          ]],
        },
      }
    );
  }
}

async function handleCVUpload(
  chatId: number,
  userId: number,
  buffer: Buffer,
  filename: string,
  fileHash?: string
): Promise<void> {
  const rawText = await extractTextFromPDF(buffer);

  if (rawText.length < 100) {
    await bot.sendMessage(chatId, "⚠️ Could not extract text. Make sure it's a text-based PDF, not a scanned image.");
    return;
  }

  await saveUserCV(userId, filename, rawText, fileHash);
  const wordCount = rawText.split(/\s+/).length;
  await bot.sendMessage(
    chatId,
    [
      `✅ *CV saved!* (${wordCount} words extracted)`,
      "",
      "Now say something like:",
      "• _Tailor my CV for Senior Product Designer at Figma_",
      "• _Generate CV for this role:_ [paste job description]",
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleCaseStudyUpload(
  chatId: number,
  userId: number,
  buffer: Buffer,
  filename: string,
  fileHash?: string
): Promise<void> {
  await bot.sendMessage(chatId, "🎨 Processing your case study — extracting content...", { parse_mode: "Markdown" });
  await bot.sendChatAction(chatId, "upload_document").catch(() => {});

  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const slug = `cs-${userId}-${Date.now()}`;

  // Extract text + render pages in parallel
  const [rawText, pages] = await Promise.all([
    extractTextFromPDF(buffer),
    extractPDFPages(buffer, 10),
  ]);

  // Archive page screenshots to /pages subfolder — for download only, not displayed
  if (pages.length > 0) {
    saveCaseStudyImages(userId, slug, pages, baseUrl);
  }

  // Use Claude Vision — send page screenshots so Claude can READ the visual content
  const { anthropic } = await import("../ai/client");

  const visionContent: Array<{ type: string; [k: string]: unknown }> = [
    {
      type: "text",
      text: `This is a designer's case study PDF with ${pages.length} pages. Read every page carefully — extract all text content, headings, bullet points, metrics, and describe any diagrams or visuals in words.\n\nExtracted text for reference:\n${rawText.slice(0, 6000)}`,
    },
  ];

  for (const page of pages.slice(0, 10)) {
    visionContent.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: page.png.toString("base64") },
    });
    visionContent.push({
      type: "text",
      text: `↑ Page ${page.pageNumber}`,
    });
  }

  visionContent.push({
    type: "text",
    text: `Now create a structured case study. Output ONLY valid JSON — no markdown, no extra text:
{
  "title": "project name",
  "role": "designer's specific role",
  "tools": "comma-separated tools used",
  "outcome": "key result or metric",
  "tags": "comma-separated tags",
  "shortIntro": "one sentence hook for the portfolio card (max 12 words)",
  "sections": [
    { "type": "heading", "text": "Section heading" },
    { "type": "paragraph", "text": "Full paragraph of real content from the PDF" },
    { "type": "stats", "items": [{ "value": "40%", "label": "drop-off reduction" }] }
  ]
}

Rules:
- Extract the ACTUAL text — reproduce real content, don't summarise
- ONLY use "heading", "paragraph", and "stats" section types — NO image sections
- Structure into: Problem/Challenge, Research/Process, Solution/Design, Results/Outcome
- Use "stats" blocks for any key metrics or numbers
- Describe any diagrams or visual content as text in paragraph sections`,
  });

  const structureRes = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: visionContent as any }],
  });

  const raw = structureRes.content[0].type === "text" ? structureRes.content[0].text.trim() : "{}";
  const json = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();

  let structured: {
    title?: string;
    role?: string;
    tools?: string;
    outcome?: string;
    tags?: string;
    shortIntro?: string;
    sections?: Array<{ type: string; text?: string; items?: Array<{ value: string; label: string }> }>;
  } = {};
  try { structured = JSON.parse(json); } catch { /* use defaults */ }

  // Save content.md — the readable source file for this work item
  const contentPath = saveCaseStudyContent(userId, slug, {
    title:     structured.title     ?? filename.replace(".pdf", ""),
    role:      structured.role,
    tools:     structured.tools,
    outcome:   structured.outcome,
    tags:      structured.tags,
    shortIntro: structured.shortIntro,
    sections:  structured.sections,
  });

  const sectionsJson = structured.sections ? JSON.stringify(structured.sections) : undefined;
  const plainDescription = structured.sections
    ? (structured.sections.find((s: any) => s.type === "paragraph") as any)?.text ?? rawText.slice(0, 300)
    : rawText.slice(0, 300);

  // Store the slug in imageUrl so the download folder can be located later
  const item = await addWorkItem(userId, {
    title:       structured.title     ?? filename.replace(".pdf", ""),
    description: plainDescription,
    role:        structured.role,
    tools:       structured.tools,
    outcome:     structured.outcome,
    imageUrl:    `${baseUrl}/uploads/${userId}/${slug}/pages/`,
    tags:        structured.tags,
    sectionsJson,
    fileHash,
  });

  const total = await getWorkItems(userId);

  await bot.sendMessage(
    chatId,
    [
      `✅ *Case study added:* ${item.title}`,
      structured.role    ? `• Role: ${structured.role}`    : null,
      structured.tools   ? `• Tools: ${structured.tools}`  : null,
      structured.outcome ? `• Outcome: ${structured.outcome}` : null,
      `• ${pages.length} page${pages.length !== 1 ? "s" : ""} archived for download`,
      `• content.md saved`,
      "",
      `You now have *${total.length} work item${total.length !== 1 ? "s" : ""}* in your portfolio.`,
      "",
      "_Say_ `generate portfolio for [role]` _when ready._",
    ].filter((l) => l !== null).join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleDocumentUpload(
  chatId: number,
  userId: number,
  document: TelegramBot.Document
): Promise<void> {
  const mime = document.mime_type ?? "";

  if (!mime.includes("pdf")) {
    await bot.sendMessage(chatId, "⚠️ Please send a *PDF* file.", { parse_mode: "Markdown" });
    return;
  }

  await bot.sendChatAction(chatId, "upload_document").catch(() => {});

  try {
    const { buffer, filename } = await downloadTelegramFile(document.file_id, token!);
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

    // Check if this exact PDF was already uploaded
    const [dupCV, dupWork] = await Promise.all([
      findCVByHash(userId, fileHash),
      findWorkItemByHash(userId, fileHash),
    ]);

    if (dupCV) {
      await bot.sendMessage(
        chatId,
        `⚠️ *This CV was already uploaded* (${dupCV.filename}).\n\nSend a different file or say _"tailor my CV"_ to use the existing one.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (dupWork) {
      await bot.sendMessage(
        chatId,
        `⚠️ *This case study was already added* — "${dupWork.title}".\n\nSend a different PDF to add a new case study.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Store the buffer and ask the user what to do with it
    const existing = pendingPDF.get(chatId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => pendingPDF.delete(chatId), 5 * 60 * 1000);
    pendingPDF.set(chatId, { buffer, filename, userId, fileHash, timer });

    await bot.sendMessage(
      chatId,
      `📎 *Got it — what is this PDF?*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "📄 CV / Resume", callback_data: "pdf_cv" },
            { text: "🎨 Case Study", callback_data: "pdf_case_study" },
          ]],
        },
      }
    );
  } catch (err: any) {
    console.error("[bot] upload error:", err);
    await bot.sendMessage(chatId, `⚠️ Failed to process file: ${err.message}`);
  }
}

function extractURLFromText(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

export async function handleUpdate(update: TelegramBot.Update): Promise<void> {
  // ── All inline button callbacks ──────────────────────────────────────────────
  if (update.callback_query) {
    const query  = update.callback_query;
    const chatId = query.message?.chat.id;
    if (!chatId) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ── Job alert buttons (Apply Now / Save) ───────────────────────────────────
    if (query.data?.startsWith("apply_alert:") || query.data?.startsWith("save_alert:")) {
      const [action, alertId] = query.data.split(":");
      const alertData = getAlert(alertId);

      if (!alertData) {
        await bot.sendMessage(chatId, "⚠️ This alert has expired. Check your followed companies for new roles.");
        return;
      }

      const user = await upsertUser(chatId, undefined);

      if (action === "save_alert") {
        const { saveJob: savej } = await import("../db/jobs");
        await savej(user.id, { title: alertData.jobTitle, company: alertData.company, location: "Remote", url: alertData.url });
        await bot.sendMessage(
          chatId,
          `💾 *Saved:* ${alertData.jobTitle} @ ${alertData.company}\n\nSay \`apply ${alertData.jobTitle} at ${alertData.company}\` when ready to apply.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // apply_alert
      await sendApplyWorkflow(chatId, user.id, alertData.jobTitle, alertData.company, alertData.url);
      return;
    }

    // ── Applied / Not yet buttons ─────────────────────────────────────────────
    if (query.data?.startsWith("applied:")) {
      const appId = parseInt(query.data.split(":")[1], 10);
      const user  = await upsertUser(chatId, undefined);
      if (appId > 0) {
        const { updateApplicationStatus } = await import("../db/jobs");
        await updateApplicationStatus(user.id, appId, "applied");
      }
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message?.message_id }).catch(() => {});
      await bot.sendMessage(chatId, `✅ *Marked as applied!*\n\nI'll remind you to follow up. Reply \`mark [company] as interviewing\` when you hear back.`, { parse_mode: "Markdown" });
      return;
    }

    if (query.data === "apply_later") {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message?.message_id }).catch(() => {});
      await bot.sendMessage(chatId, `👍 No problem — tap *✅ I Applied* whenever you submit.`, { parse_mode: "Markdown" });
      return;
    }

    // ── PDF type selection (CV vs Case Study) ──────────────────────────────────
    const pending = pendingPDF.get(chatId);
    if (!pending) {
      await bot.sendMessage(chatId, "⚠️ The upload expired — please send the PDF again.");
      return;
    }

    clearTimeout(pending.timer);
    pendingPDF.delete(chatId);

    try {
      if (query.data === "pdf_cv") {
        await bot.editMessageText("📄 Reading your CV...", { chat_id: chatId, message_id: query.message?.message_id }).catch(() => {});
        await handleCVUpload(chatId, pending.userId, pending.buffer, pending.filename, pending.fileHash);
      } else if (query.data === "pdf_case_study") {
        await bot.editMessageText("🎨 Processing your case study...", { chat_id: chatId, message_id: query.message?.message_id }).catch(() => {});
        await handleCaseStudyUpload(chatId, pending.userId, pending.buffer, pending.filename, pending.fileHash);
      }
    } catch (err: any) {
      console.error("[bot] callback error:", err.message);
      await bot.sendMessage(chatId, `⚠️ Something went wrong: ${err.message}`);
    }
    return;
  }

  const message = update.message;
  if (!message) return;

  const chatId   = message.chat.id;
  const username = message.from?.username;
  const user     = await upsertUser(chatId, username);

  // ── Document upload (PDF CV) ─────────────────────────────────────────────────
  if (message.document) {
    await handleDocumentUpload(chatId, user.id, message.document);
    return;
  }

  if (!message.text) return;

  const text = message.text.trim();

  console.log(`[bot] message from ${chatId}: ${text}`);

  // ── Follow all companies from last search ────────────────────────────────────
  if (FOLLOW_ALL_PATTERN.test(text)) {
    await handleFollowFromCache(chatId, user.id, "all");
    return;
  }

  // ── Follow specific companies by number from last search ─────────────────────
  if (FOLLOW_NUMS_PATTERN.test(text)) {
    const match = text.match(FOLLOW_NUMS_PATTERN)!;
    const indices = match[1]
      .split(/[\s,]+/)
      .map((n) => parseInt(n, 10) - 1)
      .filter((n) => !isNaN(n) && n >= 0);
    await handleFollowFromCache(chatId, user.id, indices);
    return;
  }

  // ── Mark application status ──────────────────────────────────────────────────
  const markMatch = text.match(MARK_STATUS_PATTERN);
  if (markMatch) {
    const reply = await handleUpdateStatus(user.id, markMatch[1].trim(), markMatch[2].toLowerCase());
    await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" }).catch(() => bot.sendMessage(chatId, reply));
    return;
  }

  // ── Apply to saved job by number ─────────────────────────────────────────────
  const applyMatch = text.match(APPLY_NUM_PATTERN);
  if (applyMatch) {
    const { getSavedJobs: getJobs } = await import("../db/jobs");
    const savedJobs = await getJobs(user.id);
    const idx = parseInt(applyMatch[1], 10) - 1;
    const job = savedJobs[idx];
    if (!job) {
      await bot.sendMessage(chatId, `⚠️ No saved job #${idx + 1}. Check your list with \`/status\`.`, { parse_mode: "Markdown" });
      return;
    }
    await sendApplyWorkflow(chatId, user.id, job.title, job.company, job.url);
    return;
  }

  // ── Save lead command ────────────────────────────────────────────────────────
  if (SAVE_LEAD_PATTERN.test(text)) {
    await handleSaveLead(chatId, user.id, text);
    return;
  }

  // ── Save job command ─────────────────────────────────────────────────────────
  if (SAVE_PATTERN.test(text)) {
    await handleSave(chatId, user.id, text);
    return;
  }

  // ── Slash commands ───────────────────────────────────────────────────────────
  if (text === "/start" || text === "/help") {
    clearHistory(chatId);
    await bot.sendMessage(
      chatId,
      "👋 Hey! I'm *Lokinto* — your AI career agent for design roles and freelance gigs.\n\nSend me a message like:\n• _Find senior UX roles remote_\n• _Draft an outreach to Figma's design team_\n• _Research Vercel's design culture_\n• _Find leads at Series B startups_\n\nAfter a job search, reply `save 1` or `save 1 2 3` to bookmark roles.\nType `/status` to see your saved pipeline.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/reset") {
    clearHistory(chatId);
    await bot.sendMessage(chatId, "🔄 Conversation cleared. Fresh start!");
    return;
  }

  if (text === "/status") {
    await bot.sendChatAction(chatId, "typing").catch(() => {});
    const { routeCommand: route } = await import("./router");
    const reply = await route(chatId, user.id, text, {
      intent: "status",
      params: {},
      response: "",
    });
    await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" }).catch(() => bot.sendMessage(chatId, reply));
    return;
  }

  // ── Intent-based routing ─────────────────────────────────────────────────────
  try {
    await bot.sendChatAction(chatId, "typing").catch(() => {});

    const command = await parseCommand(text);
    console.log(`[bot] parsed → intent=${command.intent} params=${JSON.stringify(command.params)}`);

    // ── Apply job: intercept — sends CV PDF + portfolio URL ─────────────────────
    if (command.intent === "apply_job") {
      const jobTitle = command.params.job_title ?? "Product Designer";
      const company  = command.params.company ?? "the company";
      const url      = command.params.url ?? extractURLFromText(text);
      let jd: string | undefined;
      if (url) {
        try {
          const { fetchJobDescription } = await import("../actions/cvGenerator");
          jd = await fetchJobDescription(url);
        } catch { /* no JD */ }
      } else if (text.length > 200) {
        jd = text;
      }
      await sendApplyWorkflow(chatId, user.id, jobTitle, company, url ?? undefined, jd);
      return;
    }

    // ── Update status: intercept for cleaner handling ────────────────────────
    if (command.intent === "update_status") {
      const company   = command.params.company ?? "";
      const newStatus = command.params.keywords ?? "applied";
      const reply     = await handleUpdateStatus(user.id, company, newStatus);
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" }).catch(() => bot.sendMessage(chatId, reply));
      return;
    }

    // ── CV generation: intercept before normal routing — sends a file ──────────
    if (command.intent === "generate_cv") {
      await bot.sendMessage(chatId, "⏳ *Tailoring your CV* — this takes about 15 seconds...", { parse_mode: "Markdown" });
      await bot.sendChatAction(chatId, "upload_document").catch(() => {});

      const result = await generateAndSendCV(user.id, command.params, text);

      if ("error" in result) {
        await bot.sendMessage(chatId, result.error, { parse_mode: "Markdown" });
      } else {
        const { pdf, filename, atsScore, keywords } = result;
        await bot.sendDocument(chatId, pdf, {}, { filename, contentType: "application/pdf" });
        await bot.sendMessage(
          chatId,
          [
            `✅ *ATS-optimised CV ready!*`,
            `📊 Estimated keyword match: *${atsScore}*`,
            ``,
            `🏷 *Keywords injected:* ${keywords.slice(0, 10).join(", ")}`,
            ``,
            `_Edit the PDF as needed before sending. Good luck! 🎯_`,
          ].join("\n"),
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    const reply = await routeCommand(chatId, user.id, text, command);

    await bot
      .sendMessage(chatId, reply, { parse_mode: "Markdown" })
      .catch(() => bot.sendMessage(chatId, reply));
  } catch (err) {
    console.error("[bot] error:", err);
    await bot.sendMessage(chatId, "⚠️ Something went wrong — please try again.").catch(() => {});
  }
}

export { bot };
