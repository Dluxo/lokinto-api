// ─── Alert cache ──────────────────────────────────────────────────────────────
// Stores job details from monitor alerts so inline "Apply Now" buttons work.
// TTL: 7 days — enough time for the user to act on a weekly alert.

interface AlertEntry {
  jobTitle: string;
  company:  string;
  url:      string;
}

const cache = new Map<string, AlertEntry>();
let counter = 0;

export function storeAlert(data: AlertEntry): string {
  const id = String(++counter);
  cache.set(id, data);
  // Auto-expire after 7 days
  setTimeout(() => cache.delete(id), 7 * 24 * 60 * 60 * 1000);
  return id;
}

export function getAlert(id: string): AlertEntry | undefined {
  return cache.get(id);
}
