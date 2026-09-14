// Prepend the shebang npm's bin linking expects, and set the exec bit.
// Kept out of TypeScript source so `tsc` never sees a non-statement first line.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve(process.cwd(), process.argv[2] ?? "");
const source = await readFile(target, "utf8");
if (!source.startsWith("#!")) {
  await writeFile(target, `#!/usr/bin/env node\n${source}`, "utf8");
}
await chmod(target, 0o755);
