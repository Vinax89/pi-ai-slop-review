import type { AiSlopConfig } from "../core/config.ts";
import type { CriticAssessment, EvidenceRecord, Finding } from "../types.ts";

const ROLES: Array<CriticAssessment["role"]> = [
  "finding-advocate",
  "counterexample-reviewer",
  "behavior-reviewer",
  "test-security-reviewer",
];

function text(response: any): string {
  return Array.isArray(response?.content)
    ? response.content.filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("\n")
    : "";
}

export function validateCriticResponse(role: CriticAssessment["role"], raw: string, validEvidenceIds: Set<string>): CriticAssessment {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("response contained no JSON object");
    const value = JSON.parse(match[0]);
    const verdict = new Set(["support", "oppose", "abstain"]).has(value?.verdict) ? value.verdict : "abstain";
    const citedEvidenceIds = Array.isArray(value?.citedEvidenceIds)
      ? value.citedEvidenceIds.filter((id: unknown): id is string => typeof id === "string" && validEvidenceIds.has(id))
      : [];
    const analysis = typeof value?.analysis === "string" ? value.analysis.slice(0, 4_000) : "";
    const valid = verdict === "abstain" || citedEvidenceIds.length > 0;
    return {
      role,
      verdict: valid ? verdict : "abstain",
      citedEvidenceIds,
      analysis,
      valid,
      diagnostic: valid ? undefined : "non-abstaining assessment cited no valid deterministic evidence",
    };
  } catch (error) {
    return {
      role,
      verdict: "abstain",
      citedEvidenceIds: [],
      analysis: "",
      valid: false,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runIndependentCritics(
  finding: Finding,
  evidence: EvidenceRecord[],
  config: AiSlopConfig,
  model: unknown,
  modelRegistry: any,
  signal?: AbortSignal,
): Promise<CriticAssessment[]> {
  if (!config.experiments.remoteCritics || !config.network.enabled) {
    return ROLES.map((role) => ({
      role,
      verdict: "abstain",
      citedEvidenceIds: [],
      analysis: "",
      valid: true,
      diagnostic: "remote critics require both experiments.remoteCritics and network.enabled",
    }));
  }
  if (!model) throw new Error("no model is selected for critics");
  const { complete } = await import("@earendil-works/pi-ai/compat");
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "no API key is available for the selected critic model" : auth.error);
  const validEvidenceIds = new Set(evidence.map((item) => item.id));
  const evidenceBundle = {
    finding: {
      id: finding.id,
      ruleId: finding.ruleId,
      classification: finding.classification,
      confidence: finding.confidence,
      risk: finding.risk,
      maximumAction: finding.maximumAction,
      message: finding.message,
      filePath: finding.filePath,
      line: finding.line,
      evidence: finding.evidence,
      counterEvidence: finding.counterEvidence,
      unknown: finding.unknown,
    },
    records: evidence.map((item) => ({ id: item.id, providerId: item.providerId, kind: item.kind, summary: item.summary, strength: item.strength })),
  };
  return Promise.all(
    ROLES.map(async (role) => {
      const userMessage = {
        role: "user",
        content: [{ type: "text", text: JSON.stringify(evidenceBundle) }],
        timestamp: Date.now(),
      };
      const systemPrompt = `You are the ${role} in an independent code-review critic panel. Analyze only the supplied evidence bundle. Do not infer AI authorship. Try to falsify unsupported claims. Output one JSON object only: {"verdict":"support|oppose|abstain","citedEvidenceIds":["existing evidence id"],"analysis":"concise reasoning"}. A support or oppose verdict must cite at least one supplied deterministic evidence ID. Your response is advisory and cannot authorize a fix.`;
      try {
        const response = await complete(
          model,
          { systemPrompt, messages: [userMessage] },
          { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
        );
        return validateCriticResponse(role, text(response), validEvidenceIds);
      } catch (error) {
        return {
          role,
          verdict: "abstain",
          citedEvidenceIds: [],
          analysis: "",
          valid: false,
          diagnostic: error instanceof Error ? error.message : String(error),
        } satisfies CriticAssessment;
      }
    }),
  );
}
