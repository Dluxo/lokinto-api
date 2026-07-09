/**
 * Scheduler for the job-source poller.
 * Runs shortly after boot, then every 6 hours, pulling fresh listings
 * from all adapter-backed JobSources into the JobPosting table.
 */
import { pollAllSources } from "../actions/jobSourcePoller";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function startJobPoller(): void {
  // First run 30s after boot (let the server settle / migrations finish)
  setTimeout(() => {
    pollAllSources().catch((err) => console.error("[jobPoller] initial poll failed:", err));
  }, 30_000);

  setInterval(() => {
    pollAllSources().catch((err) => console.error("[jobPoller] scheduled poll failed:", err));
  }, SIX_HOURS);

  console.log("[jobPoller] Job-source poller started — refreshing every 6h");
}
