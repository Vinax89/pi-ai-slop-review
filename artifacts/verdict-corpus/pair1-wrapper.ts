// Private wrapper and exported compatibility boundary.
function normalize(value: string): string {
  return normalizeDeep(value);
}

function normalizeDeep(value: string): string {
  return value.normalize("NFKC");
}

/**
 * @deprecated use parseDocument
 */
export function parseDocumentLegacy(input: string): unknown {
  return parseDocument(input);
}

export function parseDocument(input: string): unknown {
  return JSON.parse(input);
}
