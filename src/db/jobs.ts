import { prisma } from "./client";
import { JobResult } from "../actions/jobSearch";

// ─── Saved Jobs ───────────────────────────────────────────────────────────────

export async function saveJob(userId: number, job: JobResult) {
  return prisma.savedJob.upsert({
    where: { userId_url: { userId, url: job.url } },
    update: {},   // already saved — no-op
    create: {
      userId,
      title:    job.title,
      company:  job.company,
      location: job.location,
      url:      job.url,
      salary:   job.salary   ?? null,
      jobType:  job.jobType  ?? null,
      source:   job.source   ?? null,
    },
  });
}

export async function getSavedJobs(userId: number) {
  return prisma.savedJob.findMany({
    where:   { userId },
    orderBy: { savedAt: "desc" },
  });
}

export async function deleteSavedJob(userId: number, jobId: number) {
  return prisma.savedJob.deleteMany({
    where: { id: jobId, userId },
  });
}

// ─── Applications ─────────────────────────────────────────────────────────────

export async function saveApplication(
  userId: number,
  data: { jobTitle: string; company: string; url?: string; notes?: string }
) {
  return prisma.application.create({
    data: { userId, ...data },
  });
}

export async function getApplications(userId: number) {
  return prisma.application.findMany({
    where:   { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateApplicationStatus(
  userId: number,
  applicationId: number,
  status: string
) {
  return prisma.application.updateMany({
    where: { id: applicationId, userId },
    data:  { status, appliedAt: status === "applied" ? new Date() : undefined },
  });
}
