"use strict";
/*
 * A scripted secret window for the tests (interface I6). `answers` is a map from the call's name to a queue (array) of answers, or to a function that gets
 * the argument. Every call is recorded in `calls` (name and argument), so a test can see exactly what was shown and asked.
 *
 *   askGroups: [ ["0400","20G3","0G2G"], null ]       one answer per call; a function (arg) => answer is also accepted
 *   autoTypeBack: true     askGroups answers the right groups of the code last shown (a person who copied it down correctly)
 *   showThrows: true       show() fails (the window closed)
 *   askText:   { restore: [..], fallback: [..], "fallback-new": [..], invite: [..] }   queues by kind
 */

function createFakeSecretUi(answers = {}) {
  const calls = [];
  const queues = {};
  let lastGroups = null; // what show() was given last: autoTypeBack types the right groups back from it
  const take = (name, kind, arg) => {
    const spec = kind !== undefined && answers[name] && !Array.isArray(answers[name]) && typeof answers[name] !== "function" ? answers[name][kind] : answers[name];
    if (typeof spec === "function") return spec(arg);
    const k = kind === undefined ? name : `${name}:${kind}`;
    queues[k] = queues[k] || (Array.isArray(spec) ? [...spec] : []);
    return queues[k].length ? queues[k].shift() : null;
  };
  return {
    calls,
    async show(arg) {
      calls.push({ name: "show", arg });
      if (answers.showThrows) throw new Error("window closed");
      lastGroups = arg.groups;
    },
    async askGroups(arg) {
      calls.push({ name: "askGroups", arg });
      if (answers.autoTypeBack && lastGroups) return arg.positions.map((p) => lastGroups[p - 1]);
      return take("askGroups", undefined, arg);
    },
    async askText(arg) {
      calls.push({ name: "askText", arg });
      return take("askText", arg.kind, arg);
    },
    async askFolder(arg) {
      calls.push({ name: "askFolder", arg });
      return take("askFolder", arg.kind, arg);
    },
    async askChoice(arg) {
      calls.push({ name: "askChoice", arg });
      return take("askChoice", arg.kind, arg);
    },
    async say(arg) {
      calls.push({ name: "say", arg });
    },
    of(name) {
      return calls.filter((c) => c.name === name);
    },
  };
}

module.exports = { createFakeSecretUi };
