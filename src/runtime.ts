/** Runtime guards shared by the provider and controller boundaries. */
export class AgentFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentFailure";
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const nonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const tokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reject non-JSON custom-caller values before hashing or recording them. */
export function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const items = Array.isArray(value) ? Array.from(value) : Object.values(value);
  const valid = items.every((v) => isJson(v, ancestors));
  ancestors.delete(value);
  return valid;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
