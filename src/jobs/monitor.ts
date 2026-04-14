import { bot } from "../bot/handler";
import { checkCompanyJobs, filterByDesiredRoles } from "../actions/careerMonitor";
import {
  getAllFollowedCompanies,
  updateLastChecked,
  recordAlert,
  getAlertedUrls,
} from "../db/companies";
import { storeAlert } from "../bot/alertCache";

// ─── Notification formatter ───────────────────────────────────────────────────

function formatAlert(
  companyName: string,
  jobTitle: string,
  location: string | undefined,
  jobUrl: string,
  desiredRoles: string
): string {
  const lines = [
    `🔔 *New design role at ${companyName}!*`,
    "",
    `*${jobTitle}*`,
  ];

  if (location) lines.push(`📍 ${location}`);
  lines.push(`🔗 ${jobUrl}`);
  lines.push("");
  lines.push(`_You're following ${companyName} for "${desiredRoles}" roles._`);

  return lines.join("\n");
}

// ─── Core monitor logic ───────────────────────────────────────────────────────

export async function runMonitor(): Promise<void> {
  console.log("[monitor] Running career page check...");

  let followed: Awaited<ReturnType<typeof getAllFollowedCompanies>>;
  try {
    followed = await getAllFollowedCompanies();
  } catch (err) {
    console.error("[monitor] Failed to fetch followed companies:", err);
    return;
  }

  if (followed.length === 0) {
    console.log("[monitor] No followed companies — nothing to check.");
    return;
  }

  for (const company of followed) {
    try {
      const { jobs, atsType, atsToken } = await checkCompanyJobs(
        company.name,
        company.atsToken   ?? undefined,
        company.atsType    ?? undefined,
        (company as any).careersUrl ?? undefined,
      );

      const matched = filterByDesiredRoles(jobs, company.desiredRoles);
      const alertedUrls = await getAlertedUrls(company.id);

      const newJobs = matched.filter((job) => !alertedUrls.includes(job.url));

      for (const job of newJobs) {
        // Get the Telegram chat ID from the related user (telegramId is a BigInt)
        const chatId = Number(company.user.telegramId);

        const message = formatAlert(
          company.name,
          job.title,
          job.location,
          job.url,
          company.desiredRoles
        );

        try {
          const alertId = storeAlert({ jobTitle: job.title, company: company.name, url: job.url });
          await bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: "🚀 Apply Now", callback_data: `apply_alert:${alertId}` },
                { text: "💾 Save",      callback_data: `save_alert:${alertId}` },
              ]],
            },
          });
        } catch (sendErr) {
          console.error(
            `[monitor] Failed to send alert to user ${company.userId} for ${company.name}:`,
            sendErr
          );
        }

        await recordAlert(company.userId, company.id, job.title, job.url);
      }

      await updateLastChecked(company.id);

      if (newJobs.length > 0) {
        console.log(
          `[monitor] Sent ${newJobs.length} alert(s) for ${company.name} (user ${company.userId})`
        );
      }

      // Update ATS metadata if we discovered it this run
      if (
        (company.atsType == null || company.atsType === "unknown") &&
        atsType !== "unknown"
      ) {
        const { prisma } = await import("../db/client");
        await prisma.followedCompany.update({
          where: { id: company.id },
          data: { atsType, atsToken },
        });
      }
    } catch (err) {
      console.error(`[monitor] Error checking ${company.name}:`, err);
    }
  }

  console.log("[monitor] Check complete.");
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export function startMonitor(): void {
  // Run immediately on startup, then schedule for every Monday at 09:00
  runMonitor().catch(console.error);

  function scheduleNextMonday(): void {
    const now = new Date();
    const next = new Date();

    // Set to next Monday 09:00 local time
    const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7; // 1 = Monday
    next.setDate(now.getDate() + daysUntilMonday);
    next.setHours(9, 0, 0, 0);

    const msUntilNext = next.getTime() - now.getTime();
    console.log(`[monitor] Next job scan: ${next.toDateString()} at 09:00 (in ${Math.round(msUntilNext / 3600000)}h)`);

    setTimeout(() => {
      runMonitor().catch(console.error);
      scheduleNextMonday(); // reschedule for the following Monday
    }, msUntilNext);
  }

  scheduleNextMonday();
  console.log("[monitor] Career page monitor started — scanning every Monday at 09:00");
}
