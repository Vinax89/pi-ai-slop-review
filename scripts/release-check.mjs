// Release gate: verifies everything `npm publish` depends on, in one deterministic run.
// Run with `npm run release:check` before publishing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const fail = (message) => {
  console.error(`release-check: ${message}`);
  process.exit(1);
};

// 1. Registry auth. The npm browser-session token expires between sessions, so
// publish 404s with a confusing error until `npm login` refreshes it.
if (process.env.REQUIRE_NPM_AUTH === "1") {
  try {
    const whoami = execFileSync("npm", ["whoami"], { encoding: "utf8" }).trim();
    console.log(`npm auth: ${whoami}`);
  } catch {
    fail("npm whoami failed — run `npm login` before publishing.");
  }
} else {
  console.log("npm auth: skipped (set REQUIRE_NPM_AUTH=1 for the publish gate)");
}

// 2. Version consistency across package.json, npm-shrinkwrap.json, and README's git-install tag.
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const shrinkwrap = JSON.parse(readFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const completionAudit = readFileSync(new URL("../artifacts/completion-audit.md", import.meta.url), "utf8");
const verdictAcceptance = readFileSync(new URL("../artifacts/verdict-acceptance.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../skills/ai-slop-review/SKILL.md", import.meta.url), "utf8");
const extensionSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const version = packageJson.version;
if (shrinkwrap.version !== version) fail(`npm-shrinkwrap.json version ${shrinkwrap.version} != package.json ${version}`);
if (shrinkwrap.packages?.[""]?.version !== version) fail(`shrinkwrap root package version ${shrinkwrap.packages?.[""]?.version} != package.json ${version}`);
if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) fail(`package-lock.json version does not match ${version}`);
if (!readme.includes(`@v${version}`)) fail(`README git-install tag @v${version} is missing`);
if (!completionAudit.includes(`versioned \`${version}\``)) fail(`completion audit does not declare current version ${version}`);
const requiredReviewTools = ["slop_review", "slop_findings", "slop_context", "slop_verdicts", "slop_submit_verdicts"];
for (const tool of requiredReviewTools) {
  if (!skill.includes(`\`${tool}\``)) fail(`skill is missing required tool ${tool}`);
  if (!verdictAcceptance.includes(tool)) fail(`verdict acceptance reproduction command is missing ${tool}`);
  if (!extensionSource.includes(`name: "${tool}"`)) fail(`extension does not register required tool ${tool}`);
}
for (const retired of ["slop_record_verdicts", "slop_verify_verdicts"]) {
  if (skill.includes(`\`${retired}\``)) fail(`skill still requires retired tool ${retired}`);
}
for (const recoveryOption of ["resumePending", "unreviewedOnly"]) {
  if (!skill.includes(`\`${recoveryOption}`)) fail(`skill is missing checkpoint recovery option ${recoveryOption}`);
  if (!extensionSource.includes(recoveryOption)) fail(`extension is missing checkpoint recovery option ${recoveryOption}`);
}
if (!readme.includes("disabled by default")) fail("README must state that slop_intent forensics are disabled by default");
console.log(`version: ${version} (package.json, shrinkwrap, README tag consistent)`);

// 3. Full validation gate (typecheck + compile + tests + evaluation + audit).
execFileSync("npm", ["run", "validate"], { stdio: "inherit" });

// 4. Performance and containment gate.
execFileSync("npm", ["run", "benchmark"], { stdio: "inherit" });

// 5. Pack contents: required runtime files present, verdict fixtures excluded.
const packJson = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], { encoding: "utf8" }));
const pack = Array.isArray(packJson) ? packJson[0] : Object.values(packJson)[0];
const packedPaths = pack.files.map((file) => file.path);
const required = ["skills/ai-slop-review/SKILL.md", "dist/src/verdicts.js", "dist/src/isolated-scan.js", "dist/src/evaluation/repository-corpus.js", "schema/repository-corpus-manifest.schema.json", "index.ts"];
for (const file of required) {
  if (!packedPaths.includes(file)) fail(`packed package is missing ${file}`);
}
if (packedPaths.some((file) => file.startsWith("artifacts/verdict-corpus"))) fail("packed package must not contain artifacts/verdict-corpus fixtures");
if (packedPaths.some((file) => file.startsWith("evaluation-private/"))) fail("packed package must not contain private verdict labels");
if (packedPaths.some((file) => /(?:repository-manifest\.json|reviewer-[ab]\.json|repository-index\.json|\/fixtures\/)/.test(file))) fail("packed package must not contain private repository corpus inputs or labels");
console.log(`pack: ${pack.files.length} files, ${pack.unpackedSize} bytes unpacked, contents verified`);

console.log("release-check passed — publish with `npm publish` (interactive; OTP/browser auth may be required).");
