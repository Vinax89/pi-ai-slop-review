import { readFileSync } from "node:fs";

// Pair 2: hidden fallback vs typed/intentional fallback.
// Member A (expected: confirmed) — silent default, no documented contract.
export function loadFlags(): string[] {
  try {
    return JSON.parse(readFileSync("flags.json", "utf8")) as string[];
  } catch {
    return [];
  }
}

// Member B (expected: dismissed) — fallback is a documented, typed contract.
export interface Limits {
  max: number;
}

const DEFAULT_LIMITS: Limits = { max: 100 };

/** Returns DEFAULT_LIMITS merged over the file when it exists; missing or malformed files are a documented contract. */
export function loadLimits(path: string): Limits {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Limits>;
    return { ...DEFAULT_LIMITS, ...parsed };
  } catch {
    return DEFAULT_LIMITS;
  }
}
