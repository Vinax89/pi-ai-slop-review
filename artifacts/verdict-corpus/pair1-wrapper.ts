// Pair 1: private redundant wrapper vs exported compatibility wrapper.
// Member A (expected: confirmed) — unreferenced private pass-through, zero behavior added.
function normalize(value: string): string {
  return normalizeDeep(value);
}

function normalizeDeep(value: string): string {
  return value.normalize("NFKC");
}

// Member B (expected: dismissed) — exported compatibility wrapper preserving a public API.
/**
 * @deprecated use parseDocument
 */
export function parseDocumentLegacy(input: string): unknown {
  return parseDocument(input);
}

export function parseDocument(input: string): unknown {
  return JSON.parse(input);
}
