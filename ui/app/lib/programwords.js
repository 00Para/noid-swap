"use strict";
/**
 * Program mode: the words of the terminal console are "the console" and "the autopilot"; the program's person is told "the program" (and "automatic steps" where the autopilot's own
 * switch is meant). One function, on the way out of the program's request handler (server.js `send`), over every string VALUE of an answer (never a key, never a file name such as
 * `autopilot-alice.json`, never a path), and in the page (operator.js) over the texts the page's own view model builds. Display only: what the server decides, compares or writes on
 * disk keeps its own words; the terminal console is not touched (it never passes through here). Loaded by node (`require`) and by the page (`window.NoidProgramWords`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NoidProgramWords = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // whole phrases, replaced as a SUBSTRING first, so a refusal that quotes one reads exactly like the checkbox text
  const PHRASES = [
    ["No step of this swap is sent by hand outside this console while the autopilot is on.", "No step of this swap is sent by hand outside the program while it is approved."],
    ["the autopilot is already on for ", "automatic steps are already on for "],
    ["turn it off first if you want to approve again", "turn them off first if you want to approve again"],
  ];

  // A phrase followed by a file-name character ("the autopilot-alice.json", "the console/x", "the console.js") is a name, not a word: never rewritten.
  // The lookahead `(?![-/\\]|\.\w)` is on every rule.
  const RULES = [
    [/\bthis console's\b(?![-/\\]|\.\w)/g, "the program's"],
    [/\bThis console's\b(?![-/\\]|\.\w)/g, "The program's"],
    [/\bthe console's\b(?![-/\\]|\.\w)/g, "the program's"],
    [/\bThe console's\b(?![-/\\]|\.\w)/g, "The program's"],
    [/\bthis console\b(?![-/\\]|\.\w)/g, "the program"],
    [/\bThis console\b(?![-/\\]|\.\w)/g, "The program"],
    [/\bthe console\b(?![-/\\]|\.\w)/g, "the program"],
    [/\bThe console\b(?![-/\\]|\.\w)/g, "The program"],
    [/\b([Tt])he autopilot's\b(?![-/\\]|\.\w)/g, (m, t) => `${t}he program's`],
    [/\bthe autopilot\b(?![-/\\]|\.\w)/g, "the program"],
    [/\bThe autopilot\b(?![-/\\]|\.\w)/g, "The program"],
    [/\bthis autopilot\b(?![-/\\]|\.\w)/g, "the program"],
  ];

  /** One string, in the program's words. */
  function programText(s) {
    if (typeof s !== "string" || s.length < 7) return s;
    if (!/console|autopilot/i.test(s)) return s;
    let out = s;
    for (const [from, to] of PHRASES) if (out.includes(from)) out = out.split(from).join(to);
    for (const [re, to] of RULES) out = out.replace(re, to);
    return out;
  }

  const isBuf = (v) => typeof Buffer !== "undefined" && Buffer.isBuffer(v);
  /** A string, or every string value inside an object or an array (a Buffer is left as it is). */
  function programWords(value) {
    const walk = (v, depth) => {
      if (typeof v === "string") return programText(v);
      if (v === null || typeof v !== "object" || depth > 40 || typeof v.toJSON === "function" || isBuf(v)) return v;
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      return Object.fromEntries(Object.keys(v).map((k) => [k, walk(v[k], depth + 1)]));
    };
    return walk(value, 0);
  }

  return { programText, programWords };
});
