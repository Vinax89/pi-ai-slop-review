import { fileURLToPath } from "node:url";
import path from "node:path";

import { collectRepositoryCorpus } from "./repository-corpus.ts";

const manifestPath = path.resolve(process.env.SLOP_REPOSITORY_MANIFEST ?? fileURLToPath(new URL("../../evaluation-private/repository-manifest.json", import.meta.url)));
const index = await collectRepositoryCorpus(manifestPath);
process.stdout.write(`${JSON.stringify({
  kind: "repository-corpus",
  manifestPath,
  repositories: index.repositories,
  candidateCases: index.candidates.length,
  selectedCases: index.selectedFindingKeys.length,
  controls: index.controls.length,
}, null, 2)}\n`);
