"use strict";
/*
 * updates.js: the notify-only update check.
 *
 * It asks GitHub's public releases list whether a newer version of the program exists and says so. It never downloads
 * anything, never installs anything and never runs while a swap is active. The user reads the release page (the
 * installer's sha256 and its build provenance are there) and installs by hand.
 *
 * What it sends: one GET of https://api.github.com/repos/<repo>/releases?per_page=10, no cookie, no token, the generic
 * User-Agent "No1d-Swap-update-check". GitHub sees the machine's address; nothing in the request names the user, the
 * install or a swap. The answer is limited to 10 seconds and 256 KB and is parsed strictly.
 *
 * The network is injected: checkForUpdate takes `fetchJson`; createHttpsFetchJson builds the real one on node's https
 * (a test passes a fake https). No module here opens a socket by itself.
 */

const USER_AGENT = "No1d-Swap-update-check";
const TIMEOUT_MS = 10000;
const MAX_BYTES = 256 * 1024;
const API_HOST = "api.github.com";
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The words the page shows next to a newer version. */
const NOTICE_TEXT = "Check its sha256 and build provenance on that page before installing.";

const REASONS = ["not_configured", "bad_version", "timeout", "too_large", "bad_answer", "network"];

/** "1.2.3" -> [1, 2, 3]; anything else (a prefix, a suffix, a missing part) is null. */
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

class UpdateError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = REASONS.includes(reason) ? reason : "network";
  }
}

/**
 * The newest release that counts: a tag x.y.z with a leading v, neither a draft nor a prerelease. Its page address must be
 * exactly https://github.com/<repo>/releases/tag/<tag>. Anything that is not the expected shape is a bad answer (nothing
 * is guessed). Returns null when no release counts.
 */
function selectRelease(releases, repo) {
  if (!Array.isArray(releases) || releases.length > 100) throw new UpdateError("bad_answer");
  let best = null;
  for (const r of releases) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new UpdateError("bad_answer");
    if (typeof r.tag_name !== "string" || typeof r.draft !== "boolean" || typeof r.prerelease !== "boolean") throw new UpdateError("bad_answer");
    if (r.draft || r.prerelease) continue;
    const m = TAG_RE.exec(r.tag_name);
    if (!m) continue;
    const version = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (best === null || compareVersions(version, best.version) > 0) best = { version, tag: r.tag_name, htmlUrl: r.html_url };
  }
  if (best === null) return null;
  const want = `https://github.com/${repo}/releases/tag/${best.tag}`;
  if (typeof best.htmlUrl !== "string" || best.htmlUrl !== want) throw new UpdateError("bad_answer");
  return { latest: best.tag.slice(1), version: best.version, url: best.htmlUrl };
}

/** The body as a value: a string is size-checked and parsed; an already parsed value is size-checked by its text. */
function readAnswer(answer, maxBytes) {
  let text = answer;
  if (typeof text !== "string") {
    try {
      text = JSON.stringify(answer);
    } catch {
      throw new UpdateError("bad_answer");
    }
    if (typeof text !== "string") throw new UpdateError("bad_answer");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new UpdateError("too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new UpdateError("bad_answer");
  }
}

/**
 * @param {object} p
 * @param {(url:string, opts:{headers:object, timeoutMs:number, maxBytes:number, signal:AbortSignal}) => Promise<string|object>} p.fetchJson
 * @param {string} p.currentVersion "x.y.z"
 * @param {boolean} p.anyActive true while any swap is active: nothing is asked then
 * @param {string|null} p.repo "owner/name", or null when the program was built without one
 * @returns {Promise<{state:"none"|"newer"|"skipped_active"|"error", latest?:string, url?:string, reason?:string}>}
 */
async function checkForUpdate({ fetchJson, currentVersion, anyActive, repo, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES }) {
  if (anyActive) return { state: "skipped_active" };
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return { state: "error", reason: "not_configured" };
  const current = parseVersion(currentVersion);
  if (current === null) return { state: "error", reason: "bad_version" };
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new UpdateError("timeout"));
      }, timeoutMs);
    });
    const url = `https://${API_HOST}/repos/${repo}/releases?per_page=10`;
    const headers = { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" };
    const answer = await Promise.race([Promise.resolve().then(() => fetchJson(url, { headers, timeoutMs, maxBytes, signal: controller.signal })), deadline]);
    const release = selectRelease(readAnswer(answer, maxBytes), repo);
    if (release !== null && compareVersions(release.version, current) > 0) return { state: "newer", latest: release.latest, url: release.url };
    return { state: "none" };
  } catch (e) {
    return { state: "error", reason: e instanceof UpdateError ? e.reason : e && REASONS.includes(e.reason) ? e.reason : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** The real fetch, on node's https (a fake module is passed by the tests). One request, no redirect, status 200 only, no cookie. */
function createHttpsFetchJson({ https = require("https") } = {}) {
  return (url, { headers, timeoutMs, maxBytes, signal }) =>
    new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(url);
      } catch {
        reject(new UpdateError("bad_answer"));
        return;
      }
      if (u.protocol !== "https:" || u.host !== API_HOST) {
        reject(new UpdateError("bad_answer"));
        return;
      }
      const safeHeaders = { "User-Agent": headers["User-Agent"], Accept: headers.Accept };
      const req = https.get({ protocol: "https:", host: u.hostname, path: u.pathname + u.search, headers: safeHeaders, agent: false, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new UpdateError("network"));
          return;
        }
        const declared = Number(res.headers && res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.resume();
          req.destroy();
          reject(new UpdateError("too_large"));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.length;
          if (total > maxBytes) {
            req.destroy();
            reject(new UpdateError("too_large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => reject(new UpdateError("network")));
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new UpdateError("timeout"));
      });
      req.on("error", () => reject(new UpdateError("network")));
      if (signal) {
        const stop = () => {
          req.destroy();
          reject(new UpdateError("timeout"));
        };
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }
    });
}

/** Once a day: true when no check is recorded or the last one is at least a day old (or its time lies in the future). */
function isDailyDue(lastCheckedMs, nowMs) {
  if (typeof lastCheckedMs !== "number" || !Number.isFinite(lastCheckedMs)) return true;
  return nowMs - lastCheckedMs >= DAY_MS || lastCheckedMs > nowMs;
}

/** The shape /api/program shows: state, latest and url, nothing else. */
function describe(result) {
  if (result.state === "newer") return { state: "newer", latest: result.latest, url: result.url, text: NOTICE_TEXT };
  return { state: result.state, latest: null, url: null };
}

module.exports = {
  checkForUpdate,
  createHttpsFetchJson,
  selectRelease,
  parseVersion,
  compareVersions,
  isDailyDue,
  describe,
  UpdateError,
  USER_AGENT,
  TIMEOUT_MS,
  MAX_BYTES,
  NOTICE_TEXT,
  API_HOST,
};
