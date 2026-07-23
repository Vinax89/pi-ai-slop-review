import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FindingConfidence, FindingRisk, MaximumAction } from "../types.ts";

export interface ExecutableRulePolicy {
  id: string;
  confidenceCap: FindingConfidence;
  maximumAction: MaximumAction;
  risk: FindingRisk;
}

const RULES_PATH = fileURLToPath(new URL("../../library/rules.yaml", import.meta.url));

function confidence(value: string): FindingConfidence {
  if (value === "C1" || value === "C2" || value === "C3") return value;
  throw new Error(`invalid confidence '${value}' in rules.yaml`);
}

function risk(value: string): FindingRisk {
  if (value === "R1" || value === "R2" || value === "R3") return value;
  throw new Error(`invalid risk '${value}' in rules.yaml`);
}

function action(value: string): MaximumAction {
  if (value === "ignore" || value === "observe" || value === "propose" || value === "delegate-safe-fix") return value;
  throw new Error(`invalid maximum action '${value}' in rules.yaml`);
}

export function loadRulePolicies(filePath = RULES_PATH): Map<string, ExecutableRulePolicy> {
  const policies = new Map<string, ExecutableRulePolicy>();
  let current: Partial<ExecutableRulePolicy> | undefined;
  const flush = (): void => {
    if (!current) return;
    if (!current.id || !current.confidenceCap || !current.maximumAction || !current.risk) {
      throw new Error(`incomplete executable policy for '${current.id ?? "unknown"}' in rules.yaml`);
    }
    policies.set(current.id, current as ExecutableRulePolicy);
  };
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const id = line.match(/^\s*-\s+id:\s*(\S+)\s*$/)?.[1];
    if (id) {
      flush();
      current = { id };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s+(confidence_cap|maximum_action|risk):\s*(\S+)\s*$/);
    if (!field) continue;
    if (field[1] === "confidence_cap") current.confidenceCap = confidence(field[2]);
    else if (field[1] === "maximum_action") current.maximumAction = action(field[2]);
    else current.risk = risk(field[2]);
  }
  flush();
  return policies;
}
