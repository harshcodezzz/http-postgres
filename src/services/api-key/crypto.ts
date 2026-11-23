import { createHash } from "node:crypto";

export type ApiKeyEnvironment = "LIVE" | "TEST";

export function parseApiKey(apiKey: string): { environment: ApiKeyEnvironment; secret: string } | null {
  if (typeof apiKey !== "string") return null;
  const match = /^KEY_(LIVE|TEST)_([A-Za-z0-9_-]{16,})$/.exec(apiKey);
  if (!match) return null;
  return { environment: match[1] === "LIVE" ? "LIVE" : "TEST", secret: match[2] };
}

export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function maskApiKey(apiKey: string): string {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return "INVALID_KEY";
  return `KEY_${parsed.environment}_${parsed.secret.slice(0, 4)}...${parsed.secret.slice(-4)}`;
}
