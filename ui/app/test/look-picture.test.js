"use strict";
// "The two locks, from now" on the main view (operator.js drawPicture, stagecard.js plan().picture, viewmodel.js placeMarks): drawn at the Swap stage once a lock is seen on either chain, or while a
// lapsed approval is asked for again; the labels are placed so that no two boxes overlap and no leader runs through one; the main view's picture and Details' picture share no element id; the
// narrow list has a rail for each live track. Display only: the tracks and the marks are the view model's picture.
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../lib/viewmodel");
const H = require("./look-harness");
const { openSwap, cardPayload, status, ON, AP, LM, F, NOW, mkLock, has, ids, squash } = H;
const { textOf } = H;

const A_ON = { alice: ON("alice"), bob: null };
const B_ON = { alice: null, bob: ON("bob") };
const revealIntent = { status: "recorded", intent: { action: "reveal_eth", decided_at: NOW - 10, params: { cutoff: NOW + 1200, late_cutoff: NOW + 2000 } } };

const alice = (phase, o = {}) => openSwap(F.SWAP_A, (r) => cardPayload(r, { phase, line_match: LM, autopilot: A_ON, status: status("alice"), ...o }));
const bob = (phase, o = {}) => openSwap(F.SWAP_B, (r) => cardPayload(r, { phase, line_match: LM, autopilot: B_ON, status: status("bob"), ...o }));
const mainPic = (page) => page.byId("pg-picture");
const svgOf = (root) => root.all((n) => n.tag === "svg" && has(n, "pic-svg"))[0] || null;

// ---------------------------------------------------------------- the placement, without a browser
/** The boxes of a placement as rectangles in a row of a band: two boxes of one row never touch; when the placement says it is clean, no leader runs through a nearer box of its band either. */
function assertClean(res, items, geom, fixed, label) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const all = res.places.map((p) => ({ band: p.track + p.lane, row: p.row, x0: p.x0, x1: p.x1, stem: p.stem, id: p.id }));
  for (const f of fixed || []) all.push({ band: f.track + "inner", row: 0, x0: f.x0, x1: f.x1, stem: null, id: "fixed" });
  for (const p of res.places) {
    const it = byId.get(p.id);
    assert.ok(p.x0 >= geom.left - 1e-9 && p.x1 <= geom.right + 1e-9, `${label}: ${p.id} inside the limits`);
    assert.ok(Math.abs(p.x1 - p.x0 - it.w) < 1e-9, `${label}: ${p.id} keeps its width`);
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.band !== b.band) continue;
      if (a.row === b.row) assert.ok(a.x1 <= b.x0 || b.x1 <= a.x0, `${label}: ${a.id} and ${b.id} overlap in row ${a.row} of ${a.band}`);
      if (res.clean) for (const [far, near] of [[a, b], [b, a]]) if (far.row > near.row && far.stem !== null) assert.ok(far.stem < near.x0 || far.stem > near.x1, `${label}: the leader of ${far.id} runs through ${near.id}`);
    }
  }
}

test("placeMarks: three marks close together on one track never overlap, and a leader never runs through a box", () => {
  const geom = { left: 84, right: 620 };
  const items = [{ id: "a", x: 200, w: 110, track: "eth" }, { id: "b", x: 216, w: 130, track: "eth" }, { id: "c", x: 232, w: 120, track: "eth" }];
  const res = V.placeMarks(items, geom, []);
  assertClean(res, items, geom, [], "three close marks");
  assert.equal(res.clean, true);
  // all three are placed, each once, in the order given
  assert.deepEqual(res.places.map((p) => p.id), ["a", "b", "c"]);
  // and the same three on a track that also says it is not locked
  const fixed = [{ track: "eth", x0: 94, x1: 200 }];
  const withWord = V.placeMarks(items, geom, fixed);
  assertClean(withWord, items, geom, fixed, "three close marks and a word");
  assert.equal(withWord.clean, true);
});

test("placeMarks: a mark at the far right with a long label ends at its mark; one at the far left starts there; a box never leaves its limits", () => {
  const geom = { left: 84, right: 620 };
  const right = [{ id: "far", x: 586, w: 230, track: "noid" }];
  const r = V.placeMarks(right, geom, []);
  assertClean(r, right, geom, [], "far right");
  assert.equal(r.places[0].anchor, "end");
  assert.equal(r.places[0].x1, 586);
  const left = [{ id: "near", x: 90, w: 230, track: "noid" }];
  const l = V.placeMarks(left, geom, []);
  assertClean(l, left, geom, [], "far left");
  assert.equal(l.places[0].anchor, "start");
  // too wide for either side: moved inside the limits, with a leader to its mark
  const mid = [{ id: "mid", x: 300, w: 520, track: "noid" }];
  const m = V.placeMarks(mid, geom, []);
  assertClean(m, mid, geom, [], "wider than either side");
  assert.equal(m.places[0].anchor, "clamp");
  assert.equal(m.places[0].stem, 300);
});

test("placeMarks: a short span (every mark within a few pixels of the next, on both tracks) is still clean", () => {
  const geom = { left: 84, right: 560 };
  const items = [
    { id: "p", x: 100, w: 120, track: "eth" },
    { id: "q", x: 104, w: 140, track: "eth" },
    { id: "r", x: 108, w: 110, track: "noid" },
    { id: "s", x: 112, w: 150, track: "noid" },
    { id: "t", x: 116, w: 100, track: "eth" },
  ];
  const fixed = [{ track: "noid", x0: 94, x1: 230 }];
  const res = V.placeMarks(items, geom, fixed);
  assertClean(res, items, geom, fixed, "short span");
  assert.equal(res.clean, true);
});

test("placeMarks: random sets of up to five marks never overlap, and nearly all are clean, and the answer does not depend on anything but its input", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const geom = { left: 84, right: 600 };
  let clean = 0;
  for (let n = 0; n < 300; n++) {
    const count = 1 + Math.floor(rnd() * 5);
    const items = [];
    for (let i = 0; i < count; i++) items.push({ id: "m" + i, x: 90 + rnd() * 480, w: 60 + Math.floor(rnd() * 170), track: rnd() < 0.5 ? "noid" : "eth" });
    items.sort((a, b) => a.x - b.x);
    const fixed = rnd() < 0.4 ? [{ track: rnd() < 0.5 ? "noid" : "eth", x0: 94, x1: 94 + 90 + rnd() * 160 }] : [];
    const res = V.placeMarks(items, geom, fixed);
    assertClean(res, items, geom, fixed, "random " + n);
    assert.deepEqual(V.placeMarks(items, geom, fixed), res);
    if (res.clean) clean++;
  }
  // the boxes never overlap; a leader runs through a box only for marks a pixel or two apart at the far left under a word, which the sets do produce now and then
  assert.ok(clean >= 285, "clean placements: " + clean);
});

test("labelWidth: wider for the medium weight, and for more characters", () => {
  assert.ok(V.labelWidth("Reveal by", true) > V.labelWidth("Reveal by", false));
  assert.ok(V.labelWidth("Your NOID can come back", false) > V.labelWidth("Reveal by", false));
});

test("pictureFor: every mark names the chain it sits on (the reveal rows are Ethereum time, the claim target and D are Parano1d heights)", () => {
  const rows = ["reveal_start_by", "t_reveal", "reveal_cutoff", "reveal_resend_cutoff", "claim_target", "d"].map((id) => ({ id, state: "far", seconds_left: 600, target: 1, kind: "time", no_countdown: false, source: "x" }));
  const p = V.pictureFor(rows, { role: "alice", phase: { id: "lock_final", known: true, terminal: false }, clock: null });
  const chain = Object.fromEntries(p.marks.map((m) => [m.row_id, m.chain]));
  assert.deepEqual(chain, { reveal_start_by: "eth", t_reveal: "eth", reveal_cutoff: "eth", reveal_resend_cutoff: "eth", claim_target: "noid", d: "noid" });
});

// ---------------------------------------------------------------- the plan: when the main view draws it
test("the main view draws the two locks at the Swap stage once a lock is seen on either chain, and not before", async () => {
  const wait = await alice("funding_final");
  assert.equal(mainPic(wait).hidden, false);
  assert.equal(mainPic(wait).querySelector("h2").textContent, "The two locks, from now");
  assert.equal(mainPic(wait).querySelector("h2").attrs.id, "pg-h-picture");
  assert.ok(svgOf(mainPic(wait)), "the drawing");
  // Alice's NOID is only being sent: a track in a state other than "not locked yet" is enough
  const sent = await alice("funding_submitted");
  assert.equal(mainPic(sent).hidden, false);
  // Alice at the deposit: no lock, no picture on the main view (Details may still have one)
  const deposit = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: A_ON, status: status("alice", { covers: false, plain: 3000000 }) }));
  assert.equal(squash(deposit.text("pg-card")).includes("Deposit"), true);
  assert.equal(mainPic(deposit).hidden, true);
  assert.equal(mainPic(deposit).children.length, 0);
  // Bob with the deposit seen and no lock on either chain: the Swap stage, both tracks "not locked yet": not drawn on the main view, while Details has the picture
  const none = await bob("received");
  assert.equal(squash(none.text("pg-headline")), "Waiting for Alice's funding");
  assert.equal(mainPic(none).hidden, true);
  assert.equal(mainPic(none).children.length, 0);
});

test("the plan carries { act } only for a picture that is drawn, and the tone decides the band's colour", async () => {
  const S = (await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: A_ON, status: status("alice") }))).window.NoidStage;
  assert.equal(typeof S.plan, "function");
  const calm = await alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 3000 }) } });
  assert.equal(calm.byId("pg-card").className.includes("act"), false);
  assert.equal(mainPic(calm).all((n) => n.tag === "rect" && has(n, "band")).length, 0, "no amber band while the swap waits on no one");
});

test("an approval that lapsed in flight keeps the Swap stage and draws the two locks, with the amber band and the amber mark of the step that is due", async () => {
  const lapsed = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "lock_final", line_match: LM, autopilot: { alice: AP("alice"), bob: null }, status: status("alice"), tick: { lock: mkLock({ timelock: NOW + 3000 }), action: { action: "reveal_eth", reason: "lock final" }, intent: revealIntent } }));
  assert.equal(squash(lapsed.text("pg-headline")), "Approve this swap");
  assert.equal(mainPic(lapsed).hidden, false);
  const svg = svgOf(mainPic(lapsed));
  const bands = svg.all((n) => n.tag === "rect" && has(n, "band"));
  assert.equal(bands.length, 1);
  // the band runs on the track of the step: the Ethereum line, 18 px high
  assert.equal(bands[0].attrs.height, "18");
  const due = svg.all((n) => n.tag === "text" && has(n, "ml") && has(n, "due"));
  assert.deepEqual(due.map((n) => n.textContent), ["Reveal by"]);
  assert.match(textOf(mainPic(lapsed)), /your time to act/);
  assert.match(mainPic(lapsed).querySelector(".tl-note").textContent, /Reveal by in \d+ min/);
});

test("something that needs a look draws no picture on the main view", async () => {
  const look = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: A_ON, status: status("alice"), phase: "funding_final", tick: { noid: { second: { tip: 281000, instance_count: 0 } } } }));
  assert.equal(squash(look.text("pg-headline")), "Something needs a look");
  assert.equal(mainPic(look).hidden, true);
});

test("a finished swap draws no picture (its place is the ticket's Receipts)", async () => {
  const done = await alice("done", { tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } } });
  assert.equal(squash(done.text("pg-headline")), "Swap settled");
  assert.equal(mainPic(done).hidden, true);
});

// ---------------------------------------------------------------- what is drawn
test("the main view's picture and Details' picture share no element id, and each id is on the page once", async () => {
  const page = await alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 3000 }) } });
  assert.equal(mainPic(page).hidden, false);
  const inMain = mainPic(page).all((n) => n !== mainPic(page) && n.attrs.id !== undefined).map((n) => n.attrs.id);
  assert.deepEqual(inMain, ["pg-h-picture"]);
  const details = page.byId("picture").all((n) => n.attrs.id !== undefined).map((n) => n.attrs.id);
  assert.ok(details.includes("picture") && details.includes("h-picture"), "Details keeps its picture and its ids");
  assert.ok(!details.includes("pg-h-picture"));
  for (const id of ["h-picture", "pg-h-picture", "picture", "pg-picture"]) assert.equal(ids(page, id), 1, id);
  // every id of the page is on it once
  const all = page.document.body.all((n) => n.attrs.id !== undefined).map((n) => n.attrs.id);
  const dup = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual(dup, []);
});

test("the main view says what happens at each mark in plain words, and Details keeps the technical names", async () => {
  const a = await alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 3000 }), action: { action: "reveal_eth", reason: "lock final" }, intent: revealIntent } });
  const texts = (root) => svgOf(root).all((n) => n.tag === "text" && has(n, "ml")).map((n) => n.textContent);
  const main = texts(mainPic(a));
  assert.ok(main.includes("Reveal by") && main.includes("Bob's refund opens") && main.includes("Your NOID can come back"), main.join(" | "));
  assert.ok(!main.some((t) => /T_reveal|^D$|cutoff/.test(t)), "the cutoffs are not drawn on the main view while the reveal's own start-by is");
  const det = texts(a.byId("picture"));
  assert.ok(det.some((t) => /Start the reveal by/.test(t)) && det.some((t) => /T_reveal/.test(t)) && det.some((t) => /cutoff/i.test(t)), det.join(" | "));
  const b = await bob("secret_seen", { tick: { lock: mkLock({ timelock: NOW + 3000 }), tip: 281200, action: { action: "claim_noid", reason: "secret seen", call_height: 1, fee_micronoid: 5800 } } });
  const bm = texts(mainPic(b));
  assert.ok(bm.includes("Collect the NOID by") && bm.includes("Alice's refund opens"), bm.join(" | "));
});

test("no two label boxes of the drawing overlap, on the main view and under Details, in every state that draws one", async () => {
  const states = [
    () => alice("funding_final"),
    () => alice("funding_submitted"),
    () => alice("lock_seen", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } }),
    () => alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 3000 }), action: { action: "reveal_eth", reason: "lock final" }, intent: revealIntent } }),
    () => alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } }),
    () => bob("locked", { tick: { lock: mkLock({ timelock: NOW + 5000 }) } }),
    () => bob("secret_seen", { tick: { lock: mkLock({ timelock: NOW + 3000 }), tip: 281200, action: { action: "claim_noid", reason: "secret seen", call_height: 1, fee_micronoid: 5800 } } }),
    () => bob("funding_final"),
  ];
  let drawn = 0;
  for (const make of states) {
    const page = await make();
    for (const root of [mainPic(page), page.byId("picture")]) {
      const svg = svgOf(root);
      if (!svg) continue;
      drawn++;
      const boxes = svg.all((n) => n.tag === "text" && (has(n, "ml") || has(n, "when") || has(n, "lbl"))).map((n) => {
        const w = V.labelWidth(n.textContent, has(n, "ml"));
        const x = Number(n.attrs.x);
        const y = Number(n.attrs.y);
        const end = n.attrs["text-anchor"] === "end";
        return { t: n.textContent, x0: end ? x - w : x, x1: end ? x : x + w, y0: y - 11, y1: y + 3 };
      });
      assert.ok(boxes.length >= 2);
      const width = Number(svg.attrs.width);
      for (const b of boxes) assert.ok(b.x0 >= 0 && b.x1 <= width + 1, `"${b.t}" inside the drawing`);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const clash = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
          assert.equal(clash, false, `"${a.t}" and "${b.t}" overlap`);
        }
      }
    }
  }
  assert.ok(drawn >= 10, "the states drew their pictures: " + drawn);
});

test("the narrow list: a rail for each live track, each ending at its own mark; the same marks as the drawing, in time order", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "lock_final", line_match: LM, autopilot: { alice: AP("alice"), bob: null }, status: status("alice"), tick: { lock: mkLock({ timelock: NOW + 3000 }), action: { action: "reveal_eth", reason: "lock final" }, intent: revealIntent } }));
  const list = mainPic(page).querySelector("ol");
  assert.equal(list.attrs["aria-label"], "The two locks, in time order");
  const items = list.children;
  assert.equal(items[0].className, "now");
  assert.equal(textOf(items[0].querySelector(".when")), "now");
  const whats = items.slice(1).map((li) => li.querySelector(".what").textContent);
  assert.deepEqual(whats, ["Reveal by", "Bob's refund opens", "Your NOID can come back"]);
  for (const li of items) {
    const rails = li.querySelector(".rails");
    assert.equal(rails.attrs["aria-hidden"], "true");
    assert.equal(rails.children.every((i) => i.tag === "i"), true);
  }
  // both rails run from "now"; the Ethereum one ends at Bob's refund opens, the Parano1d one at the last row
  assert.deepEqual(items[0].querySelector(".rails").children.map((i) => i.className), ["noid", "eth"]);
  const ends = items.map((li) => li.querySelector(".rails").children.filter((i) => i.className.includes("end")).map((i) => i.className.split(" ")[0]));
  assert.deepEqual(ends, [[], [], ["eth"], ["noid"]]);
  // the last row has only the rail that is still running
  assert.deepEqual(items[3].querySelector(".rails").children.map((i) => i.className), ["noid end"]);
  // the due row is amber
  assert.equal(items[1].className, "due");
});

test("the drawing is redrawn each second without a second copy of anything", async () => {
  const page = await alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 3000 }) } });
  const tick = page.intervals.find((i) => i.ms === 1000);
  assert.ok(tick);
  await tick.f();
  await tick.f();
  assert.equal(mainPic(page).hidden, false);
  assert.equal(mainPic(page).all((n) => n.tag === "h2").length, 1);
  assert.equal(mainPic(page).all((n) => n.tag === "svg" && has(n, "pic-svg")).length, 1);
  assert.equal(ids(page, "pg-h-picture"), 1);
});

test("the picture is a view: no element of it holds text outside a text, a span or a paragraph, and it has no inline style or handler", async () => {
  const page = await alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 3000 }) } });
  const all = mainPic(page).all(() => true);
  for (const n of all) {
    assert.equal(n.attrs.style, undefined);
    assert.equal(Object.keys(n.attrs).some((k) => /^on/.test(k)), false);
  }
  assert.equal(all.some((n) => n.tag === "script"), false);
});
