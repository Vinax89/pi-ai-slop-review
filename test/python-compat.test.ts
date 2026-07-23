import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helpers = [
  fileURLToPath(new URL("../src/python_common.py", import.meta.url)),
  fileURLToPath(new URL("../src/python_helper.py", import.meta.url)),
  fileURLToPath(new URL("../src/python_graph_helper.py", import.meta.url)),
];

test("Python helpers parse under the Python 3.11 grammar floor and compile in the active interpreter", () => {
  const script = "import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text(encoding='utf-8'), filename=p, feature_version=(3, 11)) for p in sys.argv[1:]]";
  assert.doesNotThrow(() => execFileSync(process.env.PI_AI_SLOP_PYTHON ?? "python3", ["-I", "-S", "-c", script, ...helpers]));
  const compile = "import os, py_compile, shutil, sys, tempfile; d=tempfile.mkdtemp(); [py_compile.compile(p, cfile=os.path.join(d, str(i)+'.pyc'), doraise=True) for i,p in enumerate(sys.argv[1:])]; shutil.rmtree(d)";
  assert.doesNotThrow(() => execFileSync(process.env.PI_AI_SLOP_PYTHON ?? "python3", ["-I", "-S", "-c", compile, ...helpers]));
});
