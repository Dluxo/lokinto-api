import { checkCompanyJobs, filterByDesiredRoles } from "../actions/careerMonitor";
import {
  getAllFollowedCompanies,
  updateLastChecked,
  recordAlert,
  getAlertedUrls,
} from "../db/companies";
import { sendPushToUser } from "../notifications/push";

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
        await recordAlert(company.userId, company.id, job.title, job.url);
        await sendPushToUser(company.userId, {
          title: `New role at ${company.name}`,
          body: job.title,
          data: { screen: "pipeline", jobUrl: job.url },
        }).catch(() => {});
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

// ─── Per-user on-demand scan (no Telegram — DB + push only) ──────────────────

export async function runMonitorForUser(userId: number): Promise<number> {
  const { prisma } = await import("../db/client");
  const { sendPushToUser } = await import("../notifications/push");

  const companies = await prisma.followedCompany.findMany({
    where: { userId },
  });
  if (companies.length === 0) return 0;

  let newTotal = 0;
  for (const company of companies) {
    try {
      const { jobs, atsType, atsToken } = await checkCompanyJobs(
        company.name,
        company.atsToken  ?? undefined,
        company.atsType   ?? undefined,
        company.careersUrl ?? undefined,
      );
      const matched = filterByDesiredRoles(jobs, company.desiredRoles);
      const alertedUrls = await getAlertedUrls(company.id);
      const newJobs = matched.filter((j) => !alertedUrls.includes(j.url));

      for (const job of newJobs) {
        await recordAlert(userId, company.id, job.title, job.url);
        await sendPushToUser(userId, {
          title: `New role at ${company.name}`,
          body: job.title,
          data: { type: "new_role", jobUrl: job.url },
        }).catch(() => {});
        newTotal++;
      }

      await updateLastChecked(company.id);

      if ((company.atsType == null || company.atsType === "unknown") && atsType !== "unknown") {
        await prisma.followedCompany.update({
          where: { id: company.id },
          data: { atsType, atsToken },
        });
      }
    } catch (err) {
      console.error(`[monitor] Error scanning ${company.name} for user ${userId}:`, err);
    }
  }
  return newTotal;
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
