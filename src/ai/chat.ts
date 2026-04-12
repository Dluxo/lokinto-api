import { anthropic } from "./client";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

// In-memory conversation history per chat (chatId → messages)
const conversationHistory = new Map<number, MessageParam[]>();

const SYSTEM_PROMPT = `You are GigBot, an AI assistant specialized in helping freelancers and job seekers.
You help users:
- Find job leads and freelance opportunities
- Draft professional outreach messages
- Search for clients in specific niches
- Manage their job search pipeline

Be concise, friendly, and actionable. When a user asks to search for jobs, find leads, or draft a message,
confirm what you're going to do and ask for any missing details (e.g. job title, niche, their name).
Keep replies short and suitable for Telegram (no long walls of text).`;

export async function chat(chatId: number, userMessage: string): Promise<string> {
  // Get or create history for this chat
  if (!conversationHistory.has(chatId)) {
    conversationHistory.set(chatId, []);
  }
  const history = conversationHistory.get(chatId)!;

  // Add user message to history
  history.push({ role: "user", content: userMessage });

  // Keep last 20 messages to avoid token overflow
  const trimmed = history.slice(-20);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: trimmed,
  });

  const reply =
    response.content[0].type === "text" ? response.content[0].text : "Sorry, I could not process that.";

  // Add assistant reply to history
  history.push({ role: "assistant", content: reply });

  return reply;
}

export function clearHistory(chatId: number): void {
  conversationHistory.delete(chatId);
}
