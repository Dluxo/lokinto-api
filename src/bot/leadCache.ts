import { Lead } from "../actions/leadFinder";

// In-memory cache: chatId → last lead search results
// Lets users say "save lead 1" or "save lead 1 2 3" after a search
const cache = new Map<number, Lead[]>();

export function setLastLeads(chatId: number, leads: Lead[]): void {
  cache.set(chatId, leads);
}

export function getLastLeads(chatId: number): Lead[] {
  return cache.get(chatId) ?? [];
}
