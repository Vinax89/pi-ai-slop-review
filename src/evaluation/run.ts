import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scanFiles } from "../scan.ts";
import type { CorpusCase, CorpusEvaluation } from "./corpus.ts";
import { evaluateCorpus } from "./corpus.ts";

export async function runCorpus(cases: CorpusCase[]): Promise<CorpusEvaluation> {
  return evaluateCorpus(
    cases,
    async (corpusCase) => {
      const safeId = corpusCase.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const root = mkdtempSync(path.join(tmpdir(), `ai-slop-corpus-${safeId}-`));
      try {
        const extension = corpusCase.language === "python" ? ".py" : corpusCase.language === "javascript" ? ".js" : ".ts";
        const fileName = `input${extension}`;
        writeFileSync(path.join(root, fileName), `${corpusCase.source}\n`, "utf8");
        if (extension !== ".py") {
          writeFileSync(
            path.join(root, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, module: "NodeNext", moduleResolution: "NodeNext", strict: true } }),
            "utf8",
          );
        }
        return await scanFiles(root, [fileName]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    { requireAllSplits: true, enforceRepositoryIsolation: true },
  );
}
