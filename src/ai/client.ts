import Anthropic from "@anthropic-ai/sdk";

// Lazily instantiate the client the first time any method is called.
// This ensures dotenv has loaded before we read ANTHROPIC_API_KEY,
// regardless of module evaluation order.
let _instance: Anthropic | null = null;

function getInstance(): Anthropic {
  if (!_instance) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in environment");
    _instance = new Anthropic({ apiKey });
  }
  return _instance;
}

// Proxy so all call sites keep using `anthropic.messages.create(...)` unchanged
export const anthropic = new Proxy({} as Anthropic, {
  get(_target, prop: string | symbol) {
    return (getInstance() as any)[prop];
  },
});
