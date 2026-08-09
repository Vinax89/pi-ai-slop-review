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
let whoami = "";
try {
  whoami = execFileSync("npm", ["whoami"], { encoding: "utf8" }).trim();
  console.log(`npm auth: ${whoami}`);
} catch {
  fail("npm whoami failed — run `npm login` (interactive browser flow) before publishing; the session token expires between sessions.");
}

// 2. Version consistency across package.json, npm-shrinkwrap.json, and README's git-install tag.
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const shrinkwrap = JSON.parse(readFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const version = packageJson.version;
if (shrinkwrap.version !== version) fail(`npm-shrinkwrap.json version ${shrinkwrap.version} != package.json ${version}`);
if (shrinkwrap.packages?.[""]?.version !== version) fail(`shrinkwrap root package version ${shrinkwrap.packages?.[""]?.version} != package.json ${version}`);
if (!readme.includes(`@v${version}`)) fail(`README git-install tag @v${version} is missing`);
console.log(`version: ${version} (package.json, shrinkwrap, README tag consistent)`);

// 3. Full validation gate (typecheck + compile + tests + evaluation + audit).
execFileSync("npm", ["run", "validate"], { stdio: "inherit" });

// 4. Pack contents: required runtime files present, verdict fixtures excluded.
const pack = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], { encoding: "utf8" }))[0];
const packedPaths = pack.files.map((file) => file.path);
const required = ["skills/ai-slop-review/SKILL.md", "dist/src/verdicts.js", "dist/src/isolated-scan.js", "index.ts"];
for (const file of required) {
  if (!packedPaths.includes(file)) fail(`packed package is missing ${file}`);
}
if (packedPaths.some((file) => file.startsWith("artifacts/verdict-corpus"))) fail("packed package must not contain artifacts/verdict-corpus fixtures");
console.log(`pack: ${pack.files.length} files, ${pack.unpackedSize} bytes unpacked, contents verified`);

console.log("release-check passed — publish with `npm publish` (interactive; OTP/browser auth may be required).");
