import Anthropic from "@anthropic-ai/sdk";

let _instance: Anthropic | null = null;

function getInstance(): Anthropic {
  if (!_instance) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in environment");
    _instance = new Anthropic({ apiKey });
  }
  return _instance;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.statusCode;
      if (status === 529 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

const messagesHandler: ProxyHandler<Anthropic["messages"]> = {
  get(_, prop: string | symbol) {
    const target = getInstance().messages;
    const value = (target as any)[prop];
    if (prop === "create" && typeof value === "function") {
      return (...args: any[]) => withRetry(() => value.apply(target, args));
    }
    return typeof value === "function" ? value.bind(target) : value;
  },
};

const anthropicHandler: ProxyHandler<Anthropic> = {
  get(_, prop: string | symbol) {
    if (prop === "messages") {
      return new Proxy(getInstance().messages, messagesHandler);
    }
    const instance = getInstance();
    const value = (instance as any)[prop];
    return typeof value === "function" ? value.bind(instance) : value;
  },
};

export const anthropic = new Proxy({} as Anthropic, anthropicHandler);
