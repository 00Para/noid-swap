"use strict";
// "Post to the offers board" (lib/offerpost.js, the routes of server.js, the card's block): the offer note must pass the public board's crawler, the person's click is the only send
// (and "taken" the only automatic one), the posting key is fresh per offer, and a failed send never touches the swap. No relay is opened: `publish` is a stub, the real relay client is never built.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const op = require("../lib/offerpost");
const note = require("../lib/board/note");
const inv = require("../lib/invitation");
const Practice = require("../lib/practice");
const { makeEnv, writeRealTick } = require("./program-harness");
const { makeSettings, BOB_ETH } = require("./steps-fixtures/settings");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const SEPOLIA = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const MAINNET = "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70";
const BOB = makeSettings({ role: "bob", contract: SEPOLIA, alice_noid: null, alice_eth: null, bob_eth: null });
const BOB_MAIN = (over = {}) => makeSettings({ role: "bob", profile: "production", chain_id: 1, contract: MAINNET, amount_micronoid: "20000000000", amount_wei: "1000000000000000000", alice_noid: null, alice_eth: null, bob_eth: null, ...over });
const CODE = inv.encodeCode(BOB, BOB_ETH);
const NOW = 1_800_000_000;

// ------------------------------------------------------------------------------------------------ a port of the board's crawler checks (scripts/update-offers.mjs validateOfferEvent of the web copy)
// Everything in it is written from the crawler's rules, not from lib/offerpost.js: the pins and caps are the web copy's own table, kept here as literals.
const WEB = {
  mainnet: { pin: "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70", maxNoid: 20_000_000_000n, maxEth: 1_000_000_000_000_000_000n, versions: [1] },
  sepolia: { pin: "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF", maxNoid: 20_000_000n, maxEth: 10_000_000_000_000_000n, versions: [1, 2] },
};
const zeroBits = (hex) => {
  let n = 0;
  for (const ch of hex) {
    const v = parseInt(ch, 16);
    if (v === 0) n += 4;
    else return n + (Math.clz32(v) - 28);
  }
  return n;
};
const one = (ev, name) => {
  const t = ev.tags.filter((x) => x[0] === name);
  return t.length === 1 && t[0].length === 2 ? t[0][1] : null;
};
function crawler(ev, nowSec) {
  const bad = (reason) => ({ ok: false, reason });
  if (!note.verifyEvent(ev)) return bad("id or signature");
  if (Object.keys(ev).length !== 7 || ev.kind !== 32871 || ev.content !== "") return bad("shape");
  if (!ev.tags.some((t) => t.length === 2 && t[0] === "t" && t[1] === "no1d-swap-web-v1")) return bad("topic");
  const d = one(ev, "d");
  if (d === null || !/^[0-9a-f]{32}$/.test(d)) return bad("d");
  const sts = ev.tags.filter((t) => t[0] === "status");
  if (sts.length > 1) return bad("status twice");
  let status = "open";
  if (sts.length === 1) {
    if (sts[0].length !== 2 || !["open", "taken", "closed"].includes(sts[0][1])) return bad("status");
    status = sts[0][1];
  }
  if (ev.created_at > nowSec + 300) return bad("future");
  if (ev.created_at < nowSec - 86400) return bad("old");
  const e = one(ev, "expiration");
  if (e === null || !/^\d{1,12}$/.test(e)) return bad("expiration");
  const exp = Number(e);
  if (exp <= ev.created_at) return bad("expiration before");
  if (exp > ev.created_at + 86400 + 300) return bad("expiration too late");
  const expired = exp <= nowSec;
  if (status === "open" && expired) return bad("expired");
  const nt = ev.tags.filter((t) => t[0] === "nonce");
  if (nt.length !== 1 || nt[0].length !== 3 || !/^\d+$/.test(nt[0][1]) || !/^\d+$/.test(nt[0][2])) return bad("nonce tag");
  const target = Number(nt[0][2]);
  if (target < 16) return bad("target below 16");
  if (zeroBits(ev.id) < target) return bad("difficulty below target");
  if (status !== "open") return { ok: true, status, d, pubkey: ev.pubkey, created_at: ev.created_at };
  const inviteTags = ev.tags.filter((t) => t[0] === "invite");
  const noteTags = ev.tags.filter((t) => t[0] === "note");
  if (inviteTags.length !== 1 || inviteTags[0].length !== 2 || !inviteTags[0][1].trim().startsWith("no1dinv1:")) return bad("invite tag");
  if (noteTags.length > 1 || (noteTags.length === 1 && noteTags[0].length !== 2)) return bad("note tag");
  const rawNote = noteTags.length ? noteTags[0][1] : "";
  if (rawNote.includes("no1dinv1:")) return bad("invite code in note");
  const dec = inv.parseCode(inviteTags[0][1].trim());
  if (!dec.ok) return bad("invite code");
  const f = dec.fields;
  const spec = WEB[f.profile === "production" ? "mainnet" : f.profile];
  if (!spec) return bad("network");
  if (f.contract.toLowerCase() !== spec.pin.toLowerCase()) return bad("unpinned");
  if (f.bob_eth.toLowerCase() === f.contract.toLowerCase() || /^0x0{40}$/i.test(f.bob_eth)) return bad("bob_eth");
  const micro = BigInt(Math.round(Number(f.noid_amount) * 1e6));
  const wei = BigInt(Math.round(Number(f.eth_amount) * 1e18));
  if (micro <= 0n || micro > spec.maxNoid) return bad("noid cap");
  if (wei <= 0n || wei > spec.maxEth + 1_000_000_000_000n) return bad("eth cap");
  if (!spec.versions.includes(Number(f.contract_version))) return bad("version");
  // the crawler cleans the note with its sanitizeDisplayText to 140 characters; a note that is already clean must come out unchanged
  const shown = op.sanitizeDisplayText(rawNote, 140);
  if (shown !== rawNote) return bad("note changes when cleaned");
  return { ok: true, status: "open", d, pubkey: ev.pubkey, created_at: ev.created_at, note: shown, fields: f };
}
/** NIP-33: the newest note of each (pubkey, d) wins; the same second goes to the lower id. */
function latestPerKey(events) {
  const m = new Map();
  for (const ev of events) {
    const k = `${ev.pubkey}:${one(ev, "d")}`;
    const old = m.get(k);
    if (!old || ev.created_at > old.created_at || (ev.created_at === old.created_at && ev.id < old.id)) m.set(k, ev);
  }
  return [...m.values()];
}

// ------------------------------------------------------------------------------------------------ helpers
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "no1d-offer-"));
}
function stub(over = {}) {
  const sent = [];
  const fn = async (ev) => {
    sent.push(ev);
    if (over.fail) throw new Error(over.fail === true ? "the relays could not be reached" : over.fail);
    return { accepted: over.accepted === undefined ? 3 : over.accepted, total: 3 };
  };
  fn.sent = sent;
  return fn;
}
const poster = (publish, clock = { now: NOW }) => ({ p: op.createPoster({ publish, now: () => clock.now }), clock });
const confirmFor = (o) => op.previewOf(o).digest;

// ------------------------------------------------------------------------------------------------ the event against the board's crawler
test("an open offer passes the crawler's checks: id, signature, 16-bit work, expiry window, invite and note rules, on Sepolia and on mainnet", async () => {
  for (const [label, code] of [["sepolia", CODE], ["mainnet at the caps", inv.encodeCode(BOB_MAIN(), BOB_ETH)]]) {
    for (const text of ["", "Evenings, UTC", "5 NOID for 0.001 ETH, fast"]) {
      const pub = stub();
      const dir = tmpDir();
      const { p } = poster(pub);
      const o = { code, note: text, markTaken: true };
      await p.post({ dir, ...o, confirm: confirmFor(o) });
      assert.equal(pub.sent.length, 1);
      const r = crawler(pub.sent[0], NOW);
      assert.equal(r.ok, true, `${label} ${JSON.stringify(text)}: ${r.reason}`);
      assert.equal(r.note || "", text);
      assert.deepEqual(Object.keys(pub.sent[0]).sort(), ["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
      assert.deepEqual(pub.sent[0].tags.map((t) => t[0]), text ? ["d", "t", "expiration", "status", "invite", "note", "nonce"] : ["d", "t", "expiration", "status", "invite", "nonce"]);
    }
  }
});

test("the work is at least 16 leading zero bits and the nonce tag commits to the target; a note that commits lower or does not reach its target fails the port", async () => {
  const pub = stub();
  const { p } = poster(pub);
  const o = { code: CODE, note: "", markTaken: true };
  await p.post({ dir: tmpDir(), ...o, confirm: confirmFor(o) });
  const ev = pub.sent[0];
  assert.ok(zeroBits(ev.id) >= 16, ev.id);
  const nonce = ev.tags.find((t) => t[0] === "nonce");
  assert.equal(nonce.length, 3);
  assert.ok(Number(nonce[2]) >= 16);
  // a forged lower target (re-signed so the id and signature are right) fails the port: the port really checks the commitment
  const sk = note.generateSecretKey();
  const low = note.finalizeEvent({ kind: 32871, created_at: NOW, tags: ev.tags.filter((t) => t[0] !== "nonce").concat([["nonce", "0", "8"]]), content: "" }, sk);
  assert.equal(crawler(low, NOW).ok, false);
  assert.equal(op.MIN_POW_BITS, 16);
});

test("the expiry is 24 hours and inside the board's window; created_at is now", async () => {
  const pub = stub();
  const { p } = poster(pub);
  const o = { code: CODE, note: "", markTaken: false };
  await p.post({ dir: tmpDir(), ...o, confirm: confirmFor(o) });
  const ev = pub.sent[0];
  assert.equal(ev.created_at, NOW);
  assert.equal(Number(ev.tags.find((t) => t[0] === "expiration")[1]), NOW + 86400);
  assert.equal(crawler(ev, NOW + 86399).ok, true);
});

// ------------------------------------------------------------------------------------------------ the note
test("the note is cleaned with the board's own rules and capped at 140 characters", () => {
  assert.equal(op.cleanNote("  hello\n\tworld  "), "hello world");
  assert.equal(op.cleanNote("a​b‮c"), "abc");
  assert.equal(op.cleanNote(undefined), "");
  assert.equal(op.cleanNote(""), "");
  assert.equal(op.cleanNote("x".repeat(140)), "x".repeat(140));
  assert.throws(() => op.cleanNote("x".repeat(141)), /140 characters/);
  assert.throws(() => op.cleanNote("é".repeat(600) + "x"), /too long/);
  assert.throws(() => op.cleanNote(42), /plain text/);
  // marks pile up: the board keeps two, so does this
  assert.equal(op.cleanNote("á́́́"), "á́");
  // what comes out is what the crawler would show: cleaning it again changes nothing
  for (const t of ["  spaced   out ", "tab\there", "emoji \u{1F600} ok", "é"]) assert.equal(op.sanitizeDisplayText(op.cleanNote(t), 140), op.cleanNote(t));
});

test("a note with an invitation code in it is refused, in any letter case and with the board's hidden characters inside the prefix", () => {
  for (const t of ["see no1dinv1:AAAA", "NO1DINV1:x", "No1dInv1: x", "no1d​inv1:x", "no1dinv‮1:y", "x".repeat(10) + CODE]) assert.throws(() => op.cleanNote(t), /invitation code/, JSON.stringify(t));
  // the tag form: an event with the code in its note is dropped by the port
  const sk = note.generateSecretKey();
  const ev = op.buildEvent({ secret: sk, d: "cd".repeat(16), status: "open", code: CODE, note: "ok", now: NOW, expiresAt: NOW + 86400 });
  const tags = ev.tags.map((t) => (t[0] === "note" ? ["note", "no1dinv1:zzz"] : t)).filter((t) => t[0] !== "nonce");
  const forged = note.finalizeEvent(op.buildEvent.length ? { kind: 32871, created_at: NOW, tags, content: "" } : null, sk);
  assert.equal(crawler(forged, NOW).ok, false); // no work either: the port says so first; the note rule is covered by the cleanNote throws above
});

// ------------------------------------------------------------------------------------------------ caps and pins
test("the board's caps and pins are kept: the caps exactly, one unit over refused, an unpinned contract refused", () => {
  const atCap = inv.encodeCode(BOB_MAIN(), BOB_ETH);
  assert.equal(op.termsOf(atCap).spec.network, "mainnet");
  const overNoid = BOB_MAIN({ amount_micronoid: "20000000001" });
  assert.throws(() => inv.encodeCode(overNoid, BOB_ETH)); // the invitation itself refuses it, so no code can be offered
  assert.throws(() => op.termsOf(inv.encodeCode({ ...BOB, contract: "0x" + "ab".repeat(20) }, BOB_ETH)), /pinned contract/);
  assert.throws(() => op.termsOf(inv.encodeCode({ ...BOB_MAIN(), contract: SEPOLIA }, BOB_ETH)), /pinned contract/);
  assert.throws(() => op.termsOf(CODE.slice(0, -2) + "xx"), /./);
  assert.throws(() => op.termsOf("not a code"), /./);
  // Bob's ETH address cannot be the contract
  assert.throws(() => op.termsOf(inv.encodeCode(BOB, SEPOLIA)), /cannot be offered/);
  // the program's own caps and the board's are the same numbers
  assert.equal(op.SPECS.production.maxNoidMicro, WEB.mainnet.maxNoid);
  assert.equal(op.SPECS.production.maxEthWei, WEB.mainnet.maxEth);
  assert.equal(op.SPECS.sepolia.maxNoidMicro, WEB.sepolia.maxNoid);
  assert.equal(op.SPECS.sepolia.maxEthWei, WEB.sepolia.maxEth);
});

// ------------------------------------------------------------------------------------------------ the click, the key, the replacement
test("nothing is posted without the confirm: no digest, a wrong digest and a digest of another note all refuse before any send or any file", async () => {
  const pub = stub();
  const dir = tmpDir();
  const { p } = poster(pub);
  const good = { code: CODE, note: "hello", markTaken: true };
  for (const confirm of [undefined, "", "0".repeat(32), confirmFor({ ...good, note: "other" }), confirmFor({ ...good, markTaken: false }), 5]) {
    await assert.rejects(() => p.post({ dir, ...good, confirm }), (e) => e.status === 409 && /confirm/.test(e.message));
  }
  assert.equal(pub.sent.length, 0);
  assert.equal(fs.existsSync(path.join(dir, op.FILE)), false);
  await p.post({ dir, ...good, confirm: confirmFor(good) });
  assert.equal(pub.sent.length, 1);
});

test("the posting key is fresh per offer, is not any swap key, never leaves the module and is kept owner-only for later status notes", async () => {
  const swapKey = crypto.randomBytes(32).toString("hex"); // stands for the swap's own key and the vault's secrets
  const keys = new Set();
  const pubs = new Set();
  for (let i = 0; i < 3; i++) {
    const pub = stub();
    const dir = tmpDir();
    const { p } = poster(pub);
    const o = { code: CODE, note: "", markTaken: true };
    const view = await p.post({ dir, ...o, confirm: confirmFor(o) });
    const st = op.readState(dir);
    keys.add(st.secret);
    pubs.add(pub.sent[0].pubkey);
    assert.equal(pub.sent[0].pubkey, st.pub);
    assert.equal(note.getPublicKey(st.secret), st.pub);
    assert.notEqual(st.secret, swapKey);
    assert.ok(!JSON.stringify(view).includes(st.secret), "the page's view holds no key");
    assert.ok(!JSON.stringify(pub.sent[0]).includes(st.secret));
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, op.FILE)).mode & 0o077, 0, "owner-only");
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0);
  }
  assert.equal(keys.size, 3);
  assert.equal(pubs.size, 3);
  // the sidecar read back holds no swap material: the keys of the file are fixed
  const st = op.readState(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("no1d-offer-")).map((n) => path.join(os.tmpdir(), n)).find((d) => fs.existsSync(path.join(d, op.FILE))));
  assert.deepEqual(Object.keys(st).sort(), ["accepted", "created_at", "d", "error", "expires_at", "last_created_at", "mark_taken", "note", "pub", "published_status", "secret", "status", "v"].concat(st.attempted_at !== undefined ? ["attempted_at"] : []).sort());
});

test("taken and closed notes replace the open one by (pubkey, d): the newest wins, the status notes carry no invitation and still pass the port", async () => {
  const pub = stub();
  const dir = tmpDir();
  const clock = { now: NOW };
  const { p } = poster(pub, clock);
  const o = { code: CODE, note: "n", markTaken: true };
  await p.post({ dir, ...o, confirm: confirmFor(o) });
  clock.now = NOW + 600;
  const v1 = await p.setStatus({ dir, status: "taken" });
  assert.equal(v1.status, "taken");
  assert.equal(v1.published_status, "taken");
  clock.now = NOW + 900;
  const v2 = await p.setStatus({ dir, status: "closed" });
  assert.equal(v2.status, "closed");
  const [open, taken, closed] = pub.sent;
  assert.equal(open.pubkey, taken.pubkey);
  assert.equal(open.pubkey, closed.pubkey);
  assert.equal(open.tags.find((t) => t[0] === "d")[1], closed.tags.find((t) => t[0] === "d")[1]);
  for (const ev of [taken, closed]) {
    assert.equal(crawler(ev, ev.created_at).ok, true, crawler(ev, ev.created_at).reason);
    assert.ok(!ev.tags.some((t) => t[0] === "invite" || t[0] === "note"));
    assert.ok(zeroBits(ev.id) >= 16);
  }
  assert.equal(latestPerKey([open, taken, closed]).length, 1);
  assert.equal(one(latestPerKey([open, taken, closed])[0], "status"), "closed");
  assert.equal(one(latestPerKey([closed, open, taken])[0], "status"), "closed"); // the order the relays serve them in does not matter
  // a note in the same second as the one before is still newer: the board would otherwise keep the old one
  const clock2 = { now: NOW };
  const pub2 = stub();
  const dir2 = tmpDir();
  const q = poster(pub2, clock2).p;
  await q.post({ dir: dir2, ...o, confirm: confirmFor(o) });
  await q.setStatus({ dir: dir2, status: "closed" });
  assert.ok(pub2.sent[1].created_at > pub2.sent[0].created_at);
  // the status note's expiry covers the open note's, inside the board's 24 hours
  assert.ok(Number(closed.tags.find((t) => t[0] === "expiration")[1]) >= NOW + 86400);
  // a withdrawn offer is not taken again, and a swap with no offer has nothing to change
  await assert.rejects(() => p.setStatus({ dir, status: "taken" }), /withdrawn/);
  await assert.rejects(() => p.setStatus({ dir: tmpDir(), status: "closed" }), /no offer/);
  await assert.rejects(() => p.setStatus({ dir, status: "open" }), /taken or closed/);
});

test("a second post of an offer that is up is refused; a withdrawn one is not posted again before it has expired; an expired one can be", async () => {
  const pub = stub();
  const dir = tmpDir();
  const clock = { now: NOW };
  const { p } = poster(pub, clock);
  const o = { code: CODE, note: "", markTaken: true };
  await p.post({ dir, ...o, confirm: confirmFor(o) });
  await assert.rejects(() => p.post({ dir, ...o, confirm: confirmFor(o) }), /already up/);
  await p.setStatus({ dir, status: "closed" });
  await assert.rejects(() => p.post({ dir, ...o, confirm: confirmFor(o) }), /not posted again/);
  clock.now = NOW + 2 * 86400;
  await p.post({ dir, ...o, confirm: confirmFor(o) });
  assert.equal(pub.sent.length, 3);
  assert.notEqual(pub.sent[2].pubkey, pub.sent[0].pubkey, "a new offer gets a new key");
});

// ------------------------------------------------------------------------------------------------ failures
test("a relay failure leaves the swap untouched, keeps the key, says what happened, and the retry sends the same offer again", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "bob.swap.json"), "SWAP FILE BYTES");
  fs.writeFileSync(path.join(dir, "run.json"), "{}");
  const before = fs.readdirSync(dir).filter((n) => n !== op.FILE).map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]);
  const down = stub({ fail: "the relays could not be reached" });
  const clock = { now: NOW };
  const first = poster(down, clock).p;
  const o = { code: CODE, note: "hello", markTaken: true };
  const v = await first.post({ dir, ...o, confirm: confirmFor(o) }); // does not throw: the failure is the offer's state, not the swap's
  assert.equal(v.accepted, 0);
  assert.equal(v.published_status, null);
  assert.equal(v.pending, true);
  assert.match(v.error, /could not be reached/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== op.FILE).map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]), before);
  const st = op.readState(dir);
  // no relay took it: every relay said no
  const none = stub({ accepted: 0 });
  const v0 = await poster(none, clock).p.republish({ dir, code: CODE });
  assert.equal(v0.accepted, 0);
  assert.match(v0.error, /No relay accepted/);
  // then the relays are back: the same key and d, a newer note
  const up = stub();
  clock.now = NOW + 30;
  const v2 = await poster(up, clock).p.republish({ dir, code: CODE });
  assert.equal(v2.pending, false);
  assert.equal(v2.published_status, "open");
  assert.equal(up.sent[0].pubkey, st.pub);
  assert.equal(up.sent[0].tags.find((t) => t[0] === "d")[1], st.d);
  assert.ok(up.sent[0].created_at > none.sent[0].created_at);
  assert.equal(crawler(up.sent[0], clock.now).ok, true);
  assert.equal(one(up.sent[0], "expiration"), String(NOW + 86400), "the retry keeps the original expiry");
  await assert.rejects(() => poster(up, clock).p.republish({ dir: tmpDir(), code: CODE }), /no open offer/);
});

test("a state file that cannot be written posts nothing", async () => {
  const pub = stub();
  const { p } = poster(pub);
  const o = { code: CODE, note: "", markTaken: true };
  await assert.rejects(() => p.post({ dir: path.join(tmpDir(), "missing"), ...o, confirm: confirmFor(o) }), /Nothing was posted/);
  assert.equal(pub.sent.length, 0);
});

// ------------------------------------------------------------------------------------------------ the automatic "taken"
test("taken is sent by itself only when the choice was ticked and Alice's funding is seen; failures are retried at most every five minutes, six times", async () => {
  const wait = () => new Promise((r) => setTimeout(r, 20));
  for (const [mark, seen, want] of [[true, true, 1], [true, false, 0], [false, true, 0], [false, false, 0]]) {
    const pub = stub();
    const dir = tmpDir();
    const { p } = poster(pub);
    const o = { code: CODE, note: "", markTaken: mark };
    await p.post({ dir, ...o, confirm: confirmFor(o) });
    pub.sent.length = 0;
    assert.equal(p.autoTaken({ dir, fundingSeen: seen }), want === 1, `mark ${mark} seen ${seen}`);
    await wait();
    assert.equal(pub.sent.length, want);
    if (want) assert.equal(one(pub.sent[0], "status"), "taken");
  }
  // a swap that never had an offer: nothing
  const { p } = poster(stub());
  assert.equal(p.autoTaken({ dir: tmpDir(), fundingSeen: true }), false);
  // retries
  const down = stub({ fail: true });
  const clock = { now: NOW };
  const q = poster(stub(), clock).p;
  const dir = tmpDir();
  const o = { code: CODE, note: "", markTaken: true };
  await q.post({ dir, ...o, confirm: confirmFor(o) });
  const flaky = poster(down, clock).p;
  let sends = 0;
  for (let i = 0; i < 40; i++) {
    if (flaky.autoTaken({ dir, fundingSeen: true })) sends++;
    await wait();
    clock.now += 60;
  }
  assert.equal(sends, 6, "six tries, five minutes apart, then it waits for the person's button");
  assert.equal(down.sent.length, 6);
});

// ------------------------------------------------------------------------------------------------ the real publisher
test("the real publisher uses the three fixed wss relays only and closes its pool", async () => {
  assert.deepEqual([...op.RELAYS], ["wss://nos.lol", "wss://relay.primal.net", "wss://relay.snort.social"]);
  const opened = [];
  class FakeWS {
    constructor(url) {
      opened.push(url);
      this.url = url;
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen && this.onopen({});
        this.addEventListener && 0;
      }, 0);
    }
    addEventListener(t, fn) {
      this["on" + t] = fn;
    }
    send(frame) {
      const m = JSON.parse(frame);
      setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(["OK", m[1].id, true, ""]) }), 0);
    }
    close() {
      this.readyState = 3;
    }
  }
  const sk = note.generateSecretKey();
  const ev = op.buildEvent({ secret: sk, d: "ef".repeat(16), status: "closed", now: NOW, expiresAt: NOW + 3600 });
  const r = await op.relayPublisher({ WebSocket: FakeWS })(ev);
  assert.deepEqual(opened.sort(), [...op.RELAYS].sort());
  assert.ok(opened.every((u) => u.startsWith("wss://")));
  assert.equal(r.total, 3);
});

// ------------------------------------------------------------------------------------------------ the practice swap
test("practice: the offer move is simulated: no key, no file, no publisher, and the step does not advance", () => {
  const host = Practice.createHost();
  const s = Practice.start(host, { scenario: "settled", role: "bob" }, NOW); // Bob's practice begins at the invitation step
  assert.equal(s.action.kind, "invitation");
  assert.equal(s.action.offer.done, false);
  assert.match(s.action.offer.note, /nothing is posted/i);
  const out = Practice.act(host, { id: s.id, act: "post_offer" }, NOW);
  assert.equal(out.action.kind, "invitation", "the step stays");
  assert.equal(out.action.offer.done, true);
  assert.ok(!/wss:|nos.lol|pubkey|nsec|offer-post/.test(JSON.stringify(out)), "no relay, no key, no file name");
});

// ------------------------------------------------------------------------------------------------ the routes
const bobWithKey = (env, settings) => {
  const b = env.addSwap({ role: "bob", settings: { contract: SEPOLIA, ...(settings || {}) } });
  fs.writeFileSync(path.join(b.dir, "wallet-addresses.txt"), `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
  return b;
};

test("routes: the preview sends nothing, the post needs its digest, the payload shows the offer without the key, withdraw posts closed, the audit has the notes", async () => {
  const env = makeEnv();
  try {
    const pub = stub();
    const b = bobWithKey(env);
    const { srv, api } = await env.start({ offerPublisher: pub });
    let r = await api("POST", "/api/offerpost/preview", { swap: b.id, note: "  hello  ", mark_taken: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pv = r.body.preview;
    assert.equal(pv.note, "hello");
    assert.deepEqual(pv.relays, [...op.RELAYS]);
    assert.ok(pv.lines.some((l) => l.k === "Your ETH address" && l.v === BOB_ETH));
    assert.ok(pv.lines.some((l) => l.k === "Stays up" && /24 hours/.test(l.v)));
    assert.equal(pub.sent.length, 0, "a preview is not a send");
    assert.equal(fs.existsSync(path.join(b.dir, op.FILE)), false);

    r = await api("POST", "/api/offerpost/post", { swap: b.id, note: "hello", mark_taken: true });
    assert.equal(r.status, 409);
    r = await api("POST", "/api/offerpost/post", { swap: b.id, note: "other", mark_taken: true, digest: pv.digest });
    assert.equal(r.status, 409);
    assert.equal(pub.sent.length, 0);

    r = await api("POST", "/api/offerpost/post", { swap: b.id, note: "hello", mark_taken: true, digest: pv.digest });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(pub.sent.length, 1);
    assert.equal(crawler(pub.sent[0], Math.floor(Date.now() / 1000)).ok, true);
    assert.equal(r.body.offer.accepted, 3);

    const st = op.readState(b.dir);
    const run = await api("GET", `/api/run?swap=${b.id}`);
    assert.equal(run.status, 200);
    assert.equal(run.body.program.offer_post.posted.status, "open");
    assert.equal(run.body.program.offer_post.can_post, false);
    assert.ok(!run.text.includes(st.secret), "the key is never in the page's payload");
    assert.ok(!/no1dinv1:/.test(JSON.stringify(run.body.program.offer_post)), "nor the code");

    r = await api("POST", "/api/offerpost/status", { swap: b.id, status: "closed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.offer.status, "closed");
    assert.equal(pub.sent.length, 2);
    assert.equal(one(pub.sent[1], "status"), "closed");
    r = await api("POST", "/api/offerpost/status", { swap: b.id, status: "bogus" });
    assert.equal(r.status, 400);
    const notes = srv.swapSet.get(b.id).audit.all().filter((x) => /^offer-/.test(x.action));
    assert.deepEqual(notes.map((x) => x.action), ["offer-post", "offer-status"]);
    assert.ok(notes.every((x) => !/secret|no1dinv1/.test(JSON.stringify(x))));
  } finally {
    await env.cleanup();
  }
});

test("routes: a relay failure answers the offer's own state (200 with the error), never an error that touches the swap; Alice's swap and a swap whose funding is seen are refused", async () => {
  const env = makeEnv();
  try {
    const down = stub({ fail: "the relays could not be reached" });
    const b = bobWithKey(env);
    const a = env.addSwap({ role: "alice" });
    const b2 = bobWithKey(env);
    const { srv, api } = await env.start({ offerPublisher: down });
    const pv = (await api("POST", "/api/offerpost/preview", { swap: b.id, note: "", mark_taken: false })).body.preview;
    let r = await api("POST", "/api/offerpost/post", { swap: b.id, note: "", mark_taken: false, digest: pv.digest });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.offer.pending, true);
    assert.match(r.body.offer.error, /could not be reached/);
    // Alice has no offer to post
    r = await api("POST", "/api/offerpost/preview", { swap: a.id, note: "", mark_taken: false });
    assert.equal(r.status, 409);
    // once Alice's funding is seen the person cannot post a new offer
    writeRealTick(b2, "bob", { now: 1, phase_after: "funded", events_applied_to_file: false, intent: { status: "none", intent: null }, action: { action: "wait", reason: "x" }, notes: [] }, Math.floor(Date.now() / 1000));
    srv.swapSet.get(b2.id).snapshot = null; // the set keeps a reading of the folder for 2.5 s
    r = await api("POST", "/api/offerpost/preview", { swap: b2.id, note: "", mark_taken: false });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /funding is already seen/);
  } finally {
    await env.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ the card
test("the card: the button only previews; the publish button posts with the preview's digest; the plain sentence and the network use are on screen", async () => {
  const calls = [];
  const offer = { can_post: true, why: null, network: "sepolia", relays: [...op.RELAYS], expiry_hours: 24, note_max: 140, posted: null };
  const preview = { lines: [{ k: "Network", v: "Sepolia (a test network)" }, { k: "Note", v: "hi" }], note: "hi", network: "sepolia", label: "Sepolia (a test network)", relays: [...op.RELAYS], expiry_hours: 24, mark_taken: true, digest: "d".repeat(32) };
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog() }),
      "GET /api/run": () => ({
        status: 200,
        body: F.runPayload("bob", {
          jobs: [F.job("setup"), F.job("wallet-setup-bob")],
          wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, key_address: BOB_ETH, status: null } } },
          program: { swap: null, own_noid: null, offer_post: offer },
        }),
      }),
      "POST /api/offerpost/preview": (u, b) => {
        calls.push(["preview", b]);
        return { status: 200, body: { ok: true, preview } };
      },
      "POST /api/offerpost/post": (u, b) => {
        calls.push(["post", b]);
        return { status: 200, body: { ok: true, offer: { status: "open" } } };
      },
    }),
  });
  const rows = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"));
  await rows[1].click();
  await page.flush();
  const text = () => textOf(page.byId("pg-card"));
  assert.match(text(), /This uses the network/);
  const open = page.byId("pg-card").all((n) => n.tag === "button" && textOf(n).includes("Post to the offers board"))[0];
  assert.ok(open, "the button is on Bob's card");
  await open.click();
  await page.flush();
  assert.deepEqual(calls.map((c) => c[0]), ["preview"], "the first click is a preview only");
  assert.match(text(), /Your offer and a new posting key go to three public relays\. The relays see your IP address\. Anyone can read it\. Nothing secret is sent\./);
  assert.match(text(), /nos\.lol/);
  const pub = page.byId("pg-card").all((n) => n.tag === "button" && textOf(n).includes("Publish offer"))[0];
  assert.ok(pub);
  await pub.click();
  await page.flush();
  assert.deepEqual(calls.map((c) => c[0]), ["preview", "post"]);
  assert.equal(calls[1][1].digest, preview.digest);
  assert.equal(calls[1][1].note, "hi");
  assert.equal(calls[1][1].mark_taken, true);
});

test("routes: the program's timer marks the offer taken once Alice's funding is seen, only for an offer posted with the choice ticked, and writes one audit note", async () => {
  const env = makeEnv();
  try {
    const pub = stub();
    const yes = bobWithKey(env);
    const no = bobWithKey(env);
    const { srv, api } = await env.start({ offerPublisher: pub, timerMs: 40 });
    for (const [b, mark] of [[yes, true], [no, false]]) {
      const pv = (await api("POST", "/api/offerpost/preview", { swap: b.id, note: "", mark_taken: mark })).body.preview;
      const r = await api("POST", "/api/offerpost/post", { swap: b.id, note: "", mark_taken: mark, digest: pv.digest });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal(pub.sent.length, 2);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(pub.sent.length, 2, "nothing is sent while Alice's funding is not seen");
    const seen = { now: 1, phase_after: "funded", events_applied_to_file: false, intent: { status: "none", intent: null }, action: { action: "wait", reason: "x" }, notes: [] };
    for (const b of [yes, no]) {
      writeRealTick(b, "bob", seen, Math.floor(Date.now() / 1000));
      srv.swapSet.get(b.id).snapshot = null;
    }
    const t0 = Date.now();
    while (pub.sent.length < 3 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 40));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pub.sent.length, 3, "one taken note: for the swap whose choice was ticked");
    assert.equal(one(pub.sent[2], "status"), "taken");
    assert.equal(pub.sent[2].pubkey, op.readState(yes.dir).pub);
    assert.equal(op.readState(no.dir).status, "open");
    assert.equal(srv.swapSet.get(yes.id).audit.all().filter((x) => x.action === "offer-status").length, 1);
  } finally {
    await env.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ the first three low findings of the offer-post read
test("low 1: Try again on an open offer is refused once Alice's funding is seen or the swap has ended, and nothing is sent", async () => {
  const env = makeEnv();
  try {
    const pub = stub({ accepted: 0 });
    const b = bobWithKey(env);
    const { srv, api } = await env.start({ offerPublisher: pub });
    const pv = (await api("POST", "/api/offerpost/preview", { swap: b.id, note: "", mark_taken: false })).body.preview;
    await api("POST", "/api/offerpost/post", { swap: b.id, note: "", mark_taken: false, digest: pv.digest });
    assert.equal(pub.sent.length, 1);
    for (const phase of ["funded", "aborted"]) {
      writeRealTick(b, "bob", { now: 1, phase_after: phase, events_applied_to_file: false, intent: { status: "none", intent: null }, action: { action: "wait", reason: "x" }, notes: [] }, Math.floor(Date.now() / 1000));
      srv.swapSet.get(b.id).snapshot = null;
      const r = await api("POST", "/api/offerpost/status", { swap: b.id, status: "open" });
      assert.equal(r.status, 409, phase);
      assert.match(r.body.error, /funding is already seen/);
    }
    assert.equal(pub.sent.length, 1, "no open note went out again");
  } finally {
    await env.cleanup();
  }
});

test("low 2: an offer listed as open is closed by itself when the swap has aborted; one that was never accepted, or a swap with no offer, sends nothing", async () => {
  const env = makeEnv();
  try {
    const pub = stub();
    const b = bobWithKey(env);
    const { srv, api } = await env.start({ offerPublisher: pub, timerMs: 40 });
    const pv = (await api("POST", "/api/offerpost/preview", { swap: b.id, note: "", mark_taken: false })).body.preview;
    await api("POST", "/api/offerpost/post", { swap: b.id, note: "", mark_taken: false, digest: pv.digest });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(pub.sent.length, 1, "nothing while the swap goes on");
    writeRealTick(b, "bob", { now: 1, phase_after: "aborted", events_applied_to_file: false, intent: { status: "none", intent: null }, action: { action: "wait", reason: "x" }, notes: [] }, Math.floor(Date.now() / 1000));
    srv.swapSet.get(b.id).snapshot = null;
    const t0 = Date.now();
    while (pub.sent.length < 2 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 40));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pub.sent.length, 2);
    assert.equal(one(pub.sent[1], "status"), "closed");
    assert.equal(op.readState(b.dir).status, "closed");
  } finally {
    await env.cleanup();
  }
  // a poster that never got the offer accepted has nothing on the board to close
  const down = stub({ accepted: 0 });
  const dir = tmpDir();
  const { p } = poster(down);
  const o = { code: CODE, note: "", markTaken: false };
  await p.post({ dir, ...o, confirm: confirmFor(o) });
  assert.equal(p.autoClose({ dir }), false);
  assert.equal(p.autoClose({ dir: tmpDir() }), false);
});

test("low 3: a status note sent after the offer has expired does not extend its shown life", async () => {
  const pub = stub();
  const dir = tmpDir();
  const clock = { now: NOW };
  const { p } = poster(pub, clock);
  const o = { code: CODE, note: "", markTaken: false };
  await p.post({ dir, ...o, confirm: confirmFor(o) });
  const expires = op.readState(dir).expires_at;
  clock.now = expires + 3600;
  const v = await p.setStatus({ dir, status: "closed" });
  assert.equal(v.expires_at, expires);
  assert.equal(v.expired, true);
  assert.ok(Number(pub.sent[1].tags.find((t) => t[0] === "expiration")[1]) > pub.sent[1].created_at, "the note itself still carries a valid expiry");
});
