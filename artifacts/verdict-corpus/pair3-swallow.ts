import { fsyncSync } from "node:fs";

// Pair 3: swallowed error vs documented best-effort boundary.
// Member A (expected: confirmed) — empty catch, failure hidden with no stated reason.
export function sync(): void {
  try {
    fsyncSync(1);
  } catch {
    // ignore
  }
}

// Member B (expected: dismissed) — documented best-effort telemetry boundary.
export function emitTelemetry(event: object): void {
  try {
    void fetch("https://telemetry.example.test", {
      method: "POST",
      body: JSON.stringify(event),
    });
  } catch {
    // Best-effort telemetry: failures must never break the caller.
  }
}
