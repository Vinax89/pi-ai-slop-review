import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { clusterBehaviorEvents, inspectBehaviorEvents, reportDomainPatterns } from "../src/core/behavior.ts";
import { checkArtifactConsistency, sha256Bytes, signProvenanceManifest, verifyProvenance } from "../src/core/provenance.ts";

test("signed local provenance verifies artifact hashes and trust policy", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const artifact = Buffer.from("synthetic test artifact", "utf8");
  const manifest = signProvenanceManifest({
    version: 1,
    artifact: { id: "asset-1", sha256: sha256Bytes(artifact), mediaType: "text/plain" },
    assertions: { creator: "local-test", derivedFrom: "source-1" },
  }, {
    keyId: "test-key",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
  const trusted = publicKey.export({ format: "pem", type: "spki" }).toString();
  const result = verifyProvenance(manifest, artifact, { "test-key": trusted });
  assert.equal(result.status, "trusted");
  assert.equal(result.assertionCount, 2);

  const tampered = Buffer.from("tampered", "utf8");
  assert.equal(verifyProvenance(manifest, tampered, { "test-key": trusted }).status, "invalid");
  assert.equal(verifyProvenance(manifest, artifact, {}).status, "unverifiable");
});

test("provenance rejects malformed signature encodings and empty descriptor sets remain unverifiable", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const artifact = Buffer.from("signature encoding", "utf8");
  const manifest = signProvenanceManifest({
    version: 1,
    artifact: { id: "asset-encoding", sha256: sha256Bytes(artifact), mediaType: "text/plain" },
  }, {
    keyId: "encoding-key",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
  const trusted = publicKey.export({ format: "pem", type: "spki" }).toString();
  assert.equal(verifyProvenance({ ...manifest, signer: { ...manifest.signer, signature: "A" } }, artifact, { "encoding-key": trusted }).status, "unverifiable");
  assert.equal(checkArtifactConsistency([]).status, "unverifiable");
});

test("cross-modal descriptors report missing links and caption mismatches", () => {
  const report = checkArtifactConsistency([
    { id: "image-1", sha256: "a".repeat(64), mediaType: "image/png", sourceId: "text-1", caption: "unrelated image caption" },
    { id: "text-1", sha256: "b".repeat(64), mediaType: "text/plain", caption: "database migration instructions" },
  ]);
  assert.equal(report.status, "unverifiable");
  assert.ok(report.issues.some((issue) => issue.code === "caption-mismatch"));

  const missing = checkArtifactConsistency([{ id: "image-2", sha256: "c", mediaType: "image/png", sourceId: "missing" }]);
  assert.ok(missing.issues.some((issue) => issue.code === "missing-link"));
});

test("offline event clustering reports synchronized repeated-content domains", () => {
  const events = [
    { id: "a", actorId: "account-a", occurredAt: "2026-01-01T00:00:00Z", contentHash: "same", domain: "example.test" },
    { id: "b", actorId: "account-b", occurredAt: "2026-01-01T00:05:00Z", contentHash: "same", semanticHash: "related", domain: "example.test" },
    { id: "c", actorId: "account-c", occurredAt: "2026-01-01T00:06:00Z", semanticHash: "related", domain: "example.test" },
  ];
  const clusters = clusterBehaviorEvents(events);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].actorIds.length, 3);
  assert.ok(clusters[0].synchronizedPairs >= 1);
  const domains = reportDomainPatterns(events, clusters);
  assert.equal(domains[0].domain, "example.test");
  assert.equal(domains[0].eventCount, 3);
  assert.ok(domains[0].repeatedContentRate > 0);
});

test("behavior diagnostics reject duplicate IDs and domain pairs count only same-domain evidence", () => {
  const duplicateDiagnostics = inspectBehaviorEvents([
    { id: "dup", actorId: "a", occurredAt: "2026-01-01T00:00:00Z" },
    { id: "dup", actorId: "b", occurredAt: "2026-01-01T00:01:00Z" },
  ]);
  assert.deepEqual(duplicateDiagnostics.duplicateIds, ["dup"]);
  const events = [
    { id: "a1", actorId: "a", occurredAt: "2026-01-01T00:00:00Z", contentHash: "same", domain: "a.test" },
    { id: "b1", actorId: "b", occurredAt: "2026-01-01T00:01:00Z", contentHash: "same", domain: "b.test" },
    { id: "a2", actorId: "c", occurredAt: "2026-01-01T00:02:00Z", contentHash: "same", domain: "a.test" },
  ];
  const clusters = clusterBehaviorEvents(events);
  const domains = reportDomainPatterns(events, clusters);
  assert.equal(domains.find((domain) => domain.domain === "a.test")?.synchronizedPairCount, 1);
});

test("behavior diagnostics reject malformed events and clustering is input-order invariant", () => {
  const malformed = inspectBehaviorEvents([{ id: "", actorId: "a", occurredAt: "not-a-date" }]);
  assert.equal(malformed.accepted, 0);
  assert.equal(malformed.rejected, 1);
  assert.equal(malformed.reasons.length, 1);
  const events = [
    { id: "z", actorId: "z", occurredAt: "2026-01-01T00:02:00Z", contentHash: "same" },
    { id: "x", actorId: "x", occurredAt: "2026-01-01T00:00:00Z", contentHash: "same" },
  ];
  assert.deepEqual(clusterBehaviorEvents(events), clusterBehaviorEvents([...events].reverse()));
});
