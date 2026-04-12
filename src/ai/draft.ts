import { anthropic } from "./client";

export async function draftOutreach(context: {
  jobTitle: string;
  company: string;
  senderName: string;
}): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Write a concise, professional outreach message for a job application.
Job title: ${context.jobTitle}
Company: ${context.company}
Sender name: ${context.senderName}

Keep it under 150 words. Return plain text only.`,
      },
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
}
