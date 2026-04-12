import { JobResult } from "../actions/jobSearch";

// In-memory cache: chatId → last search results
// Lets users say "save 1" or "save 2 3" after a search
const cache = new Map<number, JobResult[]>();

export function setLastResults(chatId: number, results: JobResult[]): void {
  cache.set(chatId, results);
}

export function getLastResults(chatId: number): JobResult[] {
  return cache.get(chatId) ?? [];
}
