export interface OutreachPayload {
  to: string;
  subject: string;
  body: string;
}

/**
 * Placeholder — replace with real email/LinkedIn sending logic.
 */
export async function sendOutreach(payload: OutreachPayload): Promise<void> {
  console.log(`[outreach] sending to ${payload.to}:\n${payload.body}`);
}
