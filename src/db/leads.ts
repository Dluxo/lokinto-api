import { prisma } from "./client";
import { Lead } from "../actions/leadFinder";

export async function saveLead(userId: number, lead: Lead) {
  return prisma.savedLead.upsert({
    where: { userId_company_name: { userId, company: lead.company, name: lead.name } },
    update: {},   // already saved — no-op
    create: {
      userId,
      name:     lead.name,
      role:     lead.role    ?? null,
      company:  lead.company,
      email:    lead.email   ?? null,
      linkedIn: lead.linkedIn ?? null,
      source:   lead.source  ?? null,
    },
  });
}

export async function getSavedLeads(userId: number) {
  return prisma.savedLead.findMany({
    where:   { userId },
    orderBy: { savedAt: "desc" },
  });
}

export async function deleteSavedLead(userId: number, leadId: number) {
  return prisma.savedLead.deleteMany({
    where: { id: leadId, userId },
  });
}
