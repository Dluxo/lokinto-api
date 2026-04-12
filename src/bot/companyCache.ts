import { CompanyResult } from "../actions/companyFinder";

// In-memory cache: chatId → last company search results
// Lets users say "follow all" or "follow 1 3 5" after a company search
const cache = new Map<number, CompanyResult[]>();

export function setLastCompanies(chatId: number, companies: CompanyResult[]): void {
  cache.set(chatId, companies);
}

export function getLastCompanies(chatId: number): CompanyResult[] {
  return cache.get(chatId) ?? [];
}
