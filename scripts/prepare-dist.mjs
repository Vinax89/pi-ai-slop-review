import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });
mkdirSync(new URL("src/", dist), { recursive: true });
copyFileSync(new URL("package.json", root), new URL("package.json", dist));
copyFileSync(new URL("src/python_helper.py", root), new URL("src/python_helper.py", dist));
copyFileSync(new URL("src/python_common.py", root), new URL("src/python_common.py", dist));
copyFileSync(new URL("src/python_graph_helper.py", root), new URL("src/python_graph_helper.py", dist));
cpSync(new URL("library/", root), new URL("library/", dist), { recursive: true });
