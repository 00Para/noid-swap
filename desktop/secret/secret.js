"use strict";
/*
 * The page of the secret window (build spec 7.5). This is the only place in the program where a recovery code or a passphrase is
 * shown or typed. It talks only to `window.no1dSecret` (the preload: onShow, submit, cancel); it builds every element with
 * createElement and textContent (no inline script, no inline style, no innerHTML) and clears every input on submit and cancel.
 *
 * `buildModel` and `collect` are plain functions with no DOM so they can be tested; the DOM part runs only in a window.
 */

var TEXTS = {
  "recovery-code": {
    title: "Your recovery code",
    lines: [
      "Write these 14 groups on paper, in this order, and keep the paper somewhere safe.",
      "Anyone who has this code and your run folders can open your swaps. Without it, another computer cannot open the swaps made here.",
      "Do not photograph it, copy it or save it in a file.",
    ],
    submit: "I have written it down",
  },
  groups: {
    title: "Type part of the code back",
    lines: ["To show that you wrote the code down, type the groups at these positions."],
    submit: "Check",
    cancel: "Cancel",
  },
  restore: {
    title: "Restore with a recovery code",
    lines: ["Type your recovery code. Spaces, hyphens and capital letters do not matter."],
    field: { name: "text", label: "Recovery code", type: "text" },
    submit: "Restore",
    cancel: "Cancel",
  },
  "fallback-new": {
    title: "Choose a passphrase",
    lines: [
      "This computer has no system key store the program can use, so a passphrase of your own protects the secret that opens your swaps.",
      "Use at least 12 characters. You will be asked for it every time the program starts. If you forget it, only your recovery code can open your swaps again.",
    ],
    field: { name: "text", label: "Passphrase", type: "password" },
    fieldAgain: { name: "text", label: "Type the same passphrase again", type: "password" },
    submit: "Next",
    cancel: "Cancel",
  },
  fallback: {
    title: "Type your passphrase",
    lines: ["The program needs your passphrase to open your swaps."],
    field: { name: "text", label: "Passphrase", type: "password" },
    submit: "Open",
    cancel: "Cancel",
  },
  invite: {
    title: "Board invite",
    lines: ["Type the invite secret you were given for the offer board."],
    field: { name: "text", label: "Invite secret", type: "password" },
    submit: "Save",
    cancel: "Cancel",
  },
  "backup-code": {
    title: "Open a swap backup",
    lines: ["Type the recovery code that No1d Swap showed you on the computer this backup came from: 14 groups of 4 characters."],
    field: { name: "text", label: "Recovery code", type: "text" },
    submit: "Continue",
    cancel: "Cancel",
  },
  "backup-adopt": {
    title: "Use this recovery code?",
    lines: ["This computer will use the code you just typed from now on. The code it showed you earlier is no longer needed."],
    submit: "Use this code",
    cancel: "Cancel",
  },
  say: {
    "wrong-code": "That code does not match. Check it and try again.",
    "wrong-passphrase": "That passphrase is not right.",
    "wrong-passphrase-short": "Use at least 12 characters.",
    "wrong-passphrase-mismatch": "The two entries differ. Start again.",
    "other-install": "That recovery code belongs to a different installation. Nothing was changed.",
    "backup-wrong-code": "This code does not open this backup. Check each group and try again.",
    "backup-other-install": "This computer already has swaps under another recovery code (finished ones count too), so it cannot switch codes. Restore in a fresh user account on this computer, on another computer, or with the recovery tool.",
    "not-imported": "Nothing was imported.",
  },
};

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/** payload -> what to draw. payload is what the main process sent: { type, kind, groups?, positions?, count? } */
function buildModel(payload) {
  var p = payload && typeof payload === "object" ? payload : {};
  if (p.type === "show") {
    var t = TEXTS["recovery-code"];
    return { type: "show", title: t.title, lines: t.lines, code: Array.isArray(p.groups) ? p.groups.map(String) : [], fields: [], submit: t.submit, cancel: null };
  }
  if (p.type === "groups") {
    var g = TEXTS.groups;
    var pos = Array.isArray(p.positions) ? p.positions : [];
    return {
      type: "groups",
      title: g.title,
      lines: g.lines,
      code: [],
      fields: pos.map(function (n, i) {
        return { name: "g" + i, label: "Group " + n, type: "text" };
      }),
      submit: g.submit,
      cancel: g.cancel,
    };
  }
  if (p.type === "text" && Object.prototype.hasOwnProperty.call(TEXTS, p.kind) && p.kind !== "say" && p.kind !== "groups" && p.kind !== "recovery-code" && p.kind !== "backup-adopt") {
    var x = TEXTS[p.kind];
    if (p.kind === "fallback-new" && p.again === true) {
      return { type: "text", kind: p.kind, title: x.title, lines: ["Type the same passphrase a second time."], code: [], fields: [x.fieldAgain], submit: "Save", cancel: x.cancel };
    }
    return { type: "text", kind: p.kind, title: x.title, lines: x.lines, code: [], fields: [x.field], submit: x.submit, cancel: x.cancel };
  }
  if (p.type === "confirm" && p.kind === "backup-adopt") {
    var c = TEXTS["backup-adopt"];
    return { type: "confirm", kind: p.kind, title: c.title, lines: c.lines, code: [], fields: [], submit: c.submit, cancel: c.cancel };
  }
  if (p.type === "say") {
    var line;
    if (p.kind === "imported") {
      var n = Number.isInteger(p.count) && p.count >= 0 ? p.count : 0;
      line = "The run folder was imported." + (n > 0 ? " " + n + " old lock " + plural(n, "record was", "records were") + " added." : "");
    } else {
      line = TEXTS.say[p.kind + "-" + p.reason] || TEXTS.say[p.kind] || "Done.";
    }
    return { type: "say", title: "No1d Swap", lines: [line], code: [], fields: [], submit: "OK", cancel: null };
  }
  return { type: "none", title: "No1d Swap", lines: [], code: [], fields: [], submit: "OK", cancel: null };
}

/** What the page may send for a model and the typed values; null while it is not ready to send. */
function collect(model, values) {
  var v = values && typeof values === "object" ? values : {};
  if (model.type === "show" || model.type === "say" || model.type === "confirm") return { ack: true };
  if (model.type === "groups") {
    var out = [];
    for (var i = 0; i < model.fields.length; i++) {
      var s = String(v[model.fields[i].name] || "").trim();
      if (!s) return null;
      out.push(s);
    }
    return { groups: out };
  }
  if (model.type === "text") {
    var text = String(v.text || "");
    if (!text.trim()) return null;
    return { text: text };
  }
  return null;
}

function init(doc, api) {
  var root = doc.getElementById("root");
  var current = null;
  var inputs = [];

  function clearInputs() {
    for (var i = 0; i < inputs.length; i++) inputs[i].value = "";
  }

  function draw(model) {
    current = model;
    inputs = [];
    while (root.firstChild) root.removeChild(root.firstChild);
    var h = doc.createElement("h1");
    h.textContent = model.title;
    root.appendChild(h);
    model.lines.forEach(function (l) {
      var p = doc.createElement("p");
      p.textContent = l;
      root.appendChild(p);
    });
    if (model.code.length) {
      var box = doc.createElement("div");
      box.className = "code";
      model.code.forEach(function (grp, i) {
        var s = doc.createElement("span");
        s.className = "group";
        s.textContent = grp;
        box.appendChild(s);
        if (i < model.code.length - 1) box.appendChild(doc.createTextNode(" "));
      });
      root.appendChild(box);
    }
    var error = doc.createElement("p");
    error.className = "error";
    error.setAttribute("role", "alert");
    root.appendChild(error);
    model.fields.forEach(function (f) {
      var label = doc.createElement("label");
      var span = doc.createElement("span");
      span.textContent = f.label;
      var input = doc.createElement("input");
      input.type = f.type;
      input.name = f.name;
      input.autocomplete = "off";
      input.spellcheck = false;
      label.appendChild(span);
      label.appendChild(input);
      root.appendChild(label);
      inputs.push(input);
    });
    var row = doc.createElement("div");
    row.className = "buttons";
    var ok = doc.createElement("button");
    ok.type = "button";
    ok.textContent = model.submit;
    ok.addEventListener("click", function () {
      var values = {};
      inputs.forEach(function (i) {
        values[i.name] = i.value;
      });
      var out = collect(current, values);
      if (out === null) {
        error.textContent = "Fill in every field.";
        return;
      }
      clearInputs();
      Promise.resolve(api.submit(out)).then(function (r) {
        if (r && r.ok === false) error.textContent = r.error || "That was not accepted.";
      });
    });
    row.appendChild(ok);
    if (model.cancel) {
      var no = doc.createElement("button");
      no.type = "button";
      no.className = "secondary";
      no.textContent = model.cancel;
      no.addEventListener("click", function () {
        clearInputs();
        api.cancel();
      });
      row.appendChild(no);
    }
    root.appendChild(row);
    if (inputs[0]) inputs[0].focus();
    else ok.focus();
  }

  api.onShow(function (payload) {
    draw(buildModel(payload));
  });
}

if (typeof module === "object" && module && module.exports) {
  module.exports = { buildModel: buildModel, collect: collect, TEXTS: TEXTS };
}
if (typeof document !== "undefined" && typeof window !== "undefined" && window.no1dSecret) {
  init(document, window.no1dSecret);
}
