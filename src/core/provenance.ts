import { createHash, createPrivateKey, createPublicKey, sign as signPayload, verify as verifySignature } from "node:crypto";

export type ProvenanceStatus = "trusted" | "invalid" | "missing" | "unverifiable";

export interface ProvenanceArtifact {
  id: string;
  sha256: string;
  mediaType: string;
  size?: number;
  createdAt?: string;
}

export interface ProvenanceSigner {
  keyId: string;
  algorithm: "Ed25519";
  signature: string;
}

export interface ProvenanceManifest {
  version: 1;
  artifact: ProvenanceArtifact;
  assertions?: Record<string, unknown>;
  parentIds?: string[];
  signer: ProvenanceSigner;
}
export interface ProvenanceVerification {
  status: ProvenanceStatus;
  artifactId: string;
  expectedSha256: string;
  actualSha256: string;
  keyId?: string;
  assertionCount: number;
  reason: string;
}

export interface ArtifactDescriptor {
  id: string;
  sha256: string;
  mediaType: string;
  sourceId?: string;
  createdAt?: string;
  caption?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ConsistencyIssue {
  code: "hash-mismatch" | "missing-link" | "timestamp-mismatch" | "caption-mismatch" | "duplicate-id" | "invalid-hash" | "invalid-timestamp" | "self-link";
  severity: "warning" | "error";
  artifactIds: string[];
  message: string;
}

export interface ArtifactConsistencyReport {
  status: "consistent" | "inconsistent" | "unverifiable";
  issues: ConsistencyIssue[];
  comparedArtifacts: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
}

function signedPayload(manifest: ProvenanceManifest): Buffer {
  const { signer, ...unsigned } = manifest;
  const { signature, ...unsignedSigner } = signer;
  return Buffer.from(JSON.stringify(canonicalize({ ...unsigned, signer: unsignedSigner })), "utf8");
}
export function signProvenanceManifest(manifest: Omit<ProvenanceManifest, "signer">, signer: { keyId: string; privateKey: string }): ProvenanceManifest {
  const unsigned = { ...manifest, signer: { keyId: signer.keyId, algorithm: "Ed25519" as const, signature: "" } };
  const signature = signPayload(null, signedPayload(unsigned), createPrivateKey(signer.privateKey)).toString("base64");
  return { ...unsigned, signer: { ...unsigned.signer, signature } };
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyProvenance(manifest: unknown, artifact: Uint8Array, trustedKeys: Record<string, string>): ProvenanceVerification {
  const actualSha256 = sha256Bytes(artifact);
  if (!manifest || typeof manifest !== "object") {
    return { status: "missing", artifactId: "unknown", expectedSha256: "", actualSha256, assertionCount: 0, reason: "No provenance manifest was supplied." };
  }
  const candidate = manifest as Partial<ProvenanceManifest>;
  const artifactRecord = candidate.artifact;
  const signer = candidate.signer;
  const parentIds = candidate.parentIds;
  if (candidate.version !== 1 || !artifactRecord || typeof artifactRecord.id !== "string" || !artifactRecord.id.trim() || typeof artifactRecord.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifactRecord.sha256) || typeof artifactRecord.mediaType !== "string" || !artifactRecord.mediaType.trim() || (artifactRecord.size !== undefined && (!Number.isSafeInteger(artifactRecord.size) || artifactRecord.size < 0)) || (parentIds !== undefined && (!Array.isArray(parentIds) || parentIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(parentIds).size !== parentIds.length)) || !signer || signer.algorithm !== "Ed25519" || typeof signer.keyId !== "string" || !signer.keyId.trim() || typeof signer.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signer.signature)) {
    return { status: "unverifiable", artifactId: typeof artifactRecord?.id === "string" ? artifactRecord.id : "unknown", expectedSha256: typeof artifactRecord?.sha256 === "string" ? artifactRecord.sha256 : "", actualSha256, assertionCount: 0, reason: "Manifest shape, hash, parent, or supported signature fields are incomplete." };
  }
  const assertionCount = candidate.assertions && typeof candidate.assertions === "object" ? Object.keys(candidate.assertions).length : 0;
  if (artifactRecord.size !== undefined && artifactRecord.size !== artifact.byteLength) {
    return { status: "invalid", artifactId: artifactRecord.id, expectedSha256: artifactRecord.sha256, actualSha256, keyId: signer.keyId, assertionCount, reason: "The artifact size does not match the manifest." };
  }
  if (artifactRecord.sha256.toLowerCase() !== actualSha256) {
    return { status: "invalid", artifactId: artifactRecord.id, expectedSha256: artifactRecord.sha256, actualSha256, keyId: signer.keyId, assertionCount, reason: "The artifact hash does not match the manifest." };
  }
  const publicKey = Object.prototype.hasOwnProperty.call(trustedKeys, signer.keyId) ? trustedKeys[signer.keyId] : undefined;
  if (!publicKey) {
    return { status: "unverifiable", artifactId: artifactRecord.id, expectedSha256: artifactRecord.sha256, actualSha256, keyId: signer.keyId, assertionCount, reason: "The signing key is not trusted by the configured local trust policy." };
  }
  try {
    const signatureBytes = Buffer.from(signer.signature, "base64");
    if (signatureBytes.length !== 64) {
      return { status: "unverifiable", artifactId: artifactRecord.id, expectedSha256: artifactRecord.sha256, actualSha256, keyId: signer.keyId, assertionCount, reason: "The Ed25519 signature encoding is not a valid 64-byte signature." };
    }
    const valid = verifySignature(null, signedPayload(candidate as ProvenanceManifest), createPublicKey(publicKey), signatureBytes);
    return { status: valid ? "trusted" : "invalid", artifactId: artifactRecord.id, expectedSha256: artifactRecord.sha256, actualSha256, keyId: signer.keyId, assertionCount, reason: valid ? "Artifact hash and Ed25519 signature verified against the local trust policy." : "The Ed25519 signature is invalid." };
  } catch {
    return { status: "unverifiable", artifactId: artifactRecord.id, expectedSha256: artifactRecord.sha256, actualSha256, keyId: signer.keyId, assertionCount, reason: "The signature or configured public key could not be parsed." };
  }
}

function words(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z][a-z0-9']+/g) ?? []).filter((word) => word.length > 2));
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

export function checkArtifactConsistency(artifacts: ArtifactDescriptor[]): ArtifactConsistencyReport {
  const issues: ConsistencyIssue[] = [];
  const byId = new Map<string, ArtifactDescriptor>();
  const parsedTimes = new Map<ArtifactDescriptor, number | undefined>();
  const captionWords = new Map<ArtifactDescriptor, Set<string>>();
  const hashPattern = /^[a-f0-9]{64}$/i;
  for (const artifact of artifacts) {
    const timestamp = artifact.createdAt === undefined ? undefined : Date.parse(artifact.createdAt);
    parsedTimes.set(artifact, Number.isFinite(timestamp) ? timestamp : undefined);
    if (artifact.createdAt !== undefined && !Number.isFinite(timestamp)) issues.push({ code: "invalid-timestamp", severity: "warning", artifactIds: [artifact.id], message: "The descriptor timestamp is not parseable." });
    if (!hashPattern.test(artifact.sha256)) issues.push({ code: "invalid-hash", severity: "error", artifactIds: [artifact.id], message: "The descriptor does not contain a valid SHA-256 hash." });
    if (byId.has(artifact.id)) issues.push({ code: "duplicate-id", severity: "error", artifactIds: [artifact.id], message: "Multiple artifact descriptors use the same ID." });
    if (artifact.sourceId === artifact.id) issues.push({ code: "self-link", severity: "error", artifactIds: [artifact.id], message: "An artifact cannot declare itself as its source." });
    byId.set(artifact.id, artifact);
  }
  for (const artifact of artifacts) {
    if (artifact.sourceId && !byId.has(artifact.sourceId)) issues.push({ code: "missing-link", severity: "warning", artifactIds: [artifact.id, artifact.sourceId], message: "The descriptor references a source artifact that is not present." });
  }
  for (const artifact of artifacts) {
    if (!artifact.sourceId) continue;
    const source = byId.get(artifact.sourceId);
    if (!source) continue;
    const artifactTime = parsedTimes.get(artifact);
    const sourceTime = parsedTimes.get(source);
    if (artifactTime !== undefined && sourceTime !== undefined && Math.abs(artifactTime - sourceTime) > 366 * 24 * 60 * 60 * 1000) issues.push({ code: "timestamp-mismatch", severity: "warning", artifactIds: [source.id, artifact.id], message: "Related artifacts have timestamps more than one year apart." });
    if (artifact.caption && source.caption) {
      const artifactCaptionWords = captionWords.get(artifact) ?? words(artifact.caption);
      const sourceCaptionWords = captionWords.get(source) ?? words(source.caption);
      captionWords.set(artifact, artifactCaptionWords);
      captionWords.set(source, sourceCaptionWords);
      if (overlap(artifactCaptionWords, sourceCaptionWords) < 0.1) issues.push({ code: "caption-mismatch", severity: "warning", artifactIds: [source.id, artifact.id], message: "Related captions have little lexical overlap; inspect the declared cross-modal relationship." });
    }
  }
  return { status: issues.some((issue) => issue.severity === "error") ? "inconsistent" : issues.length ? "unverifiable" : artifacts.length ? "consistent" : "unverifiable", issues, comparedArtifacts: artifacts.length };
}
