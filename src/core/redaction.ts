const SECRET_NAME =
  "(?:(?:aws[-_])?(?:api[-_]?key|auth(?:entication)?|authorization|proxy[-_]?authorization|credential|password|passwd|secretaccesskey|accesskeyid|clientsecret|privatekey|secret|token|access[-_]?key|accesskey|secret[-_]?key|client[-_]?secret|private[-_]?key|signature|x-amz-[a-z-]+))";
const QUERY_SECRET = new RegExp(`([?&]${SECRET_NAME}[=])[^&#\\s]+`, "gi");
const ASSIGNMENT_SECRET = new RegExp(
  `((?:^|[\\s"'([{,_])(?:--?|\\/)?${SECRET_NAME}(?:[-_][a-z]+)*(?:=|\\s+))((?:\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}]*))`,
  "gi",
);
const JSON_SECRET = new RegExp(
  `((?:^|[\\s"'([{,])["']${SECRET_NAME}(?:[-_][a-z]+)*["']\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^,}\\]\\s]+)`,
  "gi",
);

/** Redact credentials from diagnostics, validator output, and other user-visible text. */
function redactAssignedValue(_match: string, prefix: string, secret: string): string {
  const plain = secret.replace(/^["']|["']$/g, "");
  return /^(?:absent|disabled|false|none|null|undefined)$/i.test(plain) ? `${prefix}${secret}` : `${prefix}<redacted>`;
}

/** Redact credentials from diagnostics, validator output, and other user-visible text. */
export function redactSensitive(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1<redacted>@")
    .replace(/((?:^|[\r\n])\s*(?:authorization|proxy-authorization)\s*:\s*)[^\r\n]*/gim, "$1<redacted>")
    .replace(QUERY_SECRET, "$1<redacted>")
    .replace(ASSIGNMENT_SECRET, redactAssignedValue)
    .replace(JSON_SECRET, '$1"<redacted>"')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted>");
}

const SECRET_KEY = new RegExp(`^(?:${SECRET_NAME})(?:[-_][a-z]+)*$`, "i");
const SECRET_FLAG = new RegExp(`^(?:(?:--?|\\/)?${SECRET_NAME}|(?:authorization|proxy-authorization):)$`, "i");

function redactConfigValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      result.push(redactConfigValue(item));
      if (typeof item === "string" && SECRET_FLAG.test(item) && index + 1 < value.length) {
        result.push("<redacted>");
        index += 1;
      }
    }
    return result;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, SECRET_KEY.test(key) ? "<redacted>" : redactConfigValue(nested)]));
}

/** Return a JSON-safe copy suitable for displaying effective configuration. */
export function redactConfig<T>(config: T): T {
  return redactConfigValue(config) as T;
}
