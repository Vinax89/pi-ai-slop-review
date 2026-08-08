// Pair 4: true duplicate implementation vs same-body separate contracts.
// Member A (expected: confirmed) — identical body, identical contract, both exported.
export function first(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values[0];
}

export function initial(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values[0];
}

// Member B (expected: dismissed) — identical body shape, distinct documented contracts.
/** Truncates to at most 80 columns for display. */
export function truncateDisplay(text: string): string {
  if (text.length <= 80) return text;
  return text.slice(0, 80);
}

/** Truncates to at most 80 characters for storage. */
export function truncateStorage(text: string): string {
  if (text.length <= 80) return text;
  return text.slice(0, 80);
}
