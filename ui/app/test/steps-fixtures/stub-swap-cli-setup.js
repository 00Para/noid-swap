"use strict";
// Stub of swap-cli for the setup-step tests (4.3): the stub of stub-lib.js plus one thing it cannot do, making the file named by `--out`.
// A scenario entry (SWAP_CLI key as in stub-lib.js) may carry `writeOut: TEXT`: the file after `--out` is written with TEXT before the usual answer
// (`new-bob` makes Bob's swap file that way). Everything else, the call log included, is stub-lib.js. Not a test file.
const fs = require("fs");

const argv = process.argv.slice(2);
try {
  const scenario = (JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, "utf8")).swapCli) || {};
  const k2 = argv.slice(0, 2).join(" ");
  const key = argv.length > 1 && scenario[k2] !== undefined ? k2 : scenario[argv[0]] !== undefined ? argv[0] : null;
  const entry = key === null ? null : scenario[key];
  const i = argv.indexOf("--out");
  if (entry && !Array.isArray(entry) && typeof entry.writeOut === "string" && i >= 0 && argv[i + 1]) fs.writeFileSync(argv[i + 1], entry.writeOut);
} catch {
  /* the plain stub answers */
}
require("./stub-lib").run("swapCli");
