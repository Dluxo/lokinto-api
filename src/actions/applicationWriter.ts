import { anthropic } from "../ai/client";
import { FormField } from "./applicationScraper";

export interface ApplicationAnswers {
  answers: Record<string, string>;   // field label → pre-written answer
  coverLetter: string;               // full cover letter
  fieldsToFill: FormField[];         // non-file fields the user needs to paste
  fieldsToUpload: FormField[];       // file fields user handles manually
}

export async function generateApplicationAnswers(
  fields: FormField[],
  cvText: string,
  jobTitle: string,
  company: string,
  portfolioUrl?: string,
  workItemsSummary?: string,
): Promise<ApplicationAnswers> {

  const fieldsToFill   = fields.filter((f) => f.type !== "file");
  const fieldsToUpload = fields.filter((f) => f.type === "file");

  // Build field list for Claude
  const fieldDescriptions = fieldsToFill
    .map((f) => `- "${f.label}" (${f.type}${f.required ? ", required" : ""})${f.hint ? ` — ${f.hint}` : ""}`)
    .join("\n");

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: `You are helping a product designer apply for a job. Write pre-filled answers for every field in their application.

Job: ${jobTitle} at ${company}
${portfolioUrl ? `Portfolio: ${portfolioUrl}` : ""}
${workItemsSummary ? `Recent work:\n${workItemsSummary}` : ""}

CV / background:
${cvText.slice(0, 3000)}

Application fields to fill:
${fieldDescriptions}

Write a natural, confident answer for EVERY field listed. For cover letters and long-form answers, be specific — reference the company name and role. Keep answers concise but compelling.

Return ONLY valid JSON — no markdown:
{
  "answers": {
    "Full Name": "...",
    "Email": "...",
    "Cover Letter": "...",
    "Why do you want to work here?": "..."
  }
}

Rules:
- For name/email/phone/LinkedIn: extract from CV if present, otherwise use placeholder like "[Your Name]"
- Portfolio URL: use ${portfolioUrl ?? "[Your Portfolio URL]"}
- Cover letter: 3 short paragraphs — hook, relevant experience, why this company
- Keep all answers professional and first-person
- Never invent specific metrics unless they appear in the CV`,
    }],
  });

  const raw   = res.content[0].type === "text" ? res.content[0].text.trim() : "{}";
  const clean = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();

  let answers: Record<string, string> = {};
  try {
    const parsed = JSON.parse(clean);
    answers = parsed.answers ?? parsed;
  } catch {
    answers = { "Cover Letter": "Could not generate — please write manually." };
  }

  const coverLetter = answers["Cover Letter"] ?? answers["cover_letter"] ?? "";

  return { answers, coverLetter, fieldsToFill, fieldsToUpload };
}

// ─── Format the application pack as a Telegram message ────────────────────────

export function formatApplicationPack(
  jobTitle: string,
  company: string,
  applyUrl: string,
  result: ApplicationAnswers,
  applicationId: number,
): { messages: string[]; callbackData: string } {
  const messages: string[] = [];

  // Message 1 — header + apply link
  messages.push([
    `📋 *Application pack: ${jobTitle} @ ${company}*`,
    "",
    `🔗 *Apply here:* ${applyUrl}`,
    "",
    `_Open the link, paste the answers below, upload your CV, and hit submit._`,
  ].join("\n"));

  // Message 2 — all pre-written answers
  const answerLines: string[] = ["📝 *Pre-written answers — copy & paste:*", ""];

  for (const field of result.fieldsToFill) {
    const answer = result.answers[field.label] ?? result.answers[field.label.toLowerCase()];
    if (!answer) continue;

    // Skip very short answers like name/email — they're obvious
    if (answer.length < 40 && !field.label.toLowerCase().includes("letter") && !field.label.toLowerCase().includes("why")) {
      answerLines.push(`*${field.label}:* ${answer}`);
    } else {
      answerLines.push(`*${field.label}:*`);
      answerLines.push(answer);
    }
    answerLines.push("");
  }

  if (result.fieldsToUpload.length > 0) {
    answerLines.push(`📎 *Upload manually:* ${result.fieldsToUpload.map((f) => f.label).join(", ")}`);
    answerLines.push("_Your tailored CV was sent above — download and upload it._");
  }

  // Split into chunks under Telegram's 4096 char limit
  const answerText = answerLines.join("\n");
  if (answerText.length <= 4000) {
    messages.push(answerText);
  } else {
    // Split at a paragraph boundary near the 4000 char mark
    const mid = answerText.lastIndexOf("\n\n", 4000);
    messages.push(answerText.slice(0, mid > 0 ? mid : 4000));
    messages.push(answerText.slice(mid > 0 ? mid : 4000));
  }

  return {
    messages,
    callbackData: `applied:${applicationId}`,
  };
}
