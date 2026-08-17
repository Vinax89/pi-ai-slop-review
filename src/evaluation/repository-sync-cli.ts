import { fileURLToPath } from "node:url";
import path from "node:path";

import { syncRepositoryCorpus } from "./repository-corpus.ts";

const manifestPath = path.resolve(process.env.SLOP_REPOSITORY_MANIFEST ?? fileURLToPath(new URL("../../evaluation-private/repository-manifest.json", import.meta.url)));
const results = syncRepositoryCorpus(manifestPath);
process.stdout.write(`${JSON.stringify({ kind: "repository-corpus-sync", manifestPath, results }, null, 2)}\n`);
