"use strict";
/*
 * updates.js: the notify-only update check.
 *
 * It asks GitHub's public releases list whether a newer version of the program exists and says so. It never downloads
 * anything, never installs anything and never runs while a swap is active. The user compares the installer's SHA-256 with
 * the value in the signed notice (shown with the answer) and installs by hand.
 *
 * What it sends: one GET of https://api.github.com/repos/<repo>/releases?per_page=10 (and, only while the newest release is not signed and no older
 * signed notice is among those ten, up to four more pages of ten), no cookie, no token, the generic
 * User-Agent "No1d-Swap-update-check". GitHub sees the machine's address; nothing in the request names the user, the
 * install or a swap. The answer is limited to 10 seconds and 256 KB and is parsed strictly.
 *
 * The signed release notice (docs/release-key.md): a release counts as "newer" only when its release.json and release.json.sig
 * assets (fetched through the API's asset address, 8 KB and 512 bytes at most, the same rules, no cookie, no token; the one
 * redirect GitHub answers with may go only to GitHub's own asset hosts) carry a valid Ed25519 signature by the key compiled into
 * releasekey.js, and the signed version equals the release's tag. With no key compiled in the check says so and asks nothing.
 * The same signed file can say that the running version is below "oldest_safe_version": that sets unsafeForNewSwaps (the
 * console server can refuse to start a NEW swap on it; it never touches a running swap, a refund, a recovery or a sweep).
 *
 * The network is injected: checkForUpdate takes `fetchJson`; createHttpsFetchJson builds the real one on node's https
 * (a test passes a fake https). No module here opens a socket by itself.
 */

const releaseFile = require("./releasefile");
const releaseKey = require("./releasekey");

const USER_AGENT = "No1d-Swap-update-check";
const TIMEOUT_MS = 10000;
const MAX_BYTES = 256 * 1024;
const API_HOST = "api.github.com";
/** The hosts GitHub's asset download may redirect to (one hop, https, default port, no credentials). */
const ASSET_HOSTS = ["objects.githubusercontent.com", "release-assets.githubusercontent.com"];
const NOTICE_FILE = "release.json";
const SIG_FILE = "release.json.sig";
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The first request asks for 10 releases; while the newest is unsigned and no older signed notice is among them, at most this many further pages of 10 are read. */
const PAGE_SIZE = 10;
const MAX_EXTRA_PAGES = 4;

/** The words the page shows next to a newer version. */
const NOTICE_TEXT = "Compare the installer's SHA-256 with the signed value below before installing.";

/** Shown when a newer release is listed but its signed notice is missing or does not check. */
const UNVERIFIED_TEXT = "A newer release is listed but its signature does not check: do not install it.";
/** Shown while the build carries no release key. */
const KEY_MISSING_TEXT = "The release check is not configured in this build, so no new version can be announced.";

const REASONS = ["key_not_configured", "not_configured", "bad_version", "timeout", "too_large", "bad_answer", "network"];

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

/** The reason word of a failure (anything that is not one of ours is a network failure). */
function reasonOf(e) {
  return e instanceof UpdateError ? e.reason : e && REASONS.includes(e.reason) ? e.reason : "network";
}

/** The ids of the two notice assets by exact name; a missing one, a repeated one or a bad id is simply absent. */
function assetsOf(list) {
  const found = {};
  if (!Array.isArray(list) || list.length > 200) return found;
  const count = {};
  for (const a of list) {
    if (a === null || typeof a !== "object" || typeof a.name !== "string") continue;
    count[a.name] = (count[a.name] || 0) + 1;
    if ((a.name === NOTICE_FILE || a.name === SIG_FILE) && Number.isSafeInteger(a.id) && a.id > 0) found[a.name] = a.id;
  }
  for (const n of [NOTICE_FILE, SIG_FILE]) if (count[n] !== 1) delete found[n];
  return found;
}

/**
 * The newest release that counts: a tag x.y.z with a leading v, neither a draft nor a prerelease. Its page address must be
 * exactly https://github.com/<repo>/releases/tag/<tag>. Anything that is not the expected shape is a bad answer (nothing
 * is guessed). Returns null when no release counts.
 */
function listCandidateReleases(releases, repo) {
  if (!Array.isArray(releases) || releases.length > 100) throw new UpdateError("bad_answer");
  const out = [];
  for (const r of releases) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new UpdateError("bad_answer");
    if (typeof r.tag_name !== "string" || typeof r.draft !== "boolean" || typeof r.prerelease !== "boolean") throw new UpdateError("bad_answer");
    if (r.draft || r.prerelease) continue;
    const m = TAG_RE.exec(r.tag_name);
    if (!m) continue;
    out.push({ version: [Number(m[1]), Number(m[2]), Number(m[3])], tag: r.tag_name, htmlUrl: r.html_url, assets: r.assets });
  }
  out.sort((a, b) => compareVersions(b.version, a.version));
  if (out.length === 0) return [];
  const top = out[0];
  const wantTop = `https://github.com/${repo}/releases/tag/${top.tag}`;
  if (typeof top.htmlUrl !== "string" || top.htmlUrl !== wantTop) throw new UpdateError("bad_answer");
  return out
    .filter((r) => typeof r.htmlUrl === "string" && r.htmlUrl === `https://github.com/${repo}/releases/tag/${r.tag}`)
    .map((r) => ({ latest: r.tag.slice(1), version: r.version, url: r.htmlUrl, assets: assetsOf(r.assets) }));
}

function selectRelease(releases, repo) {
  const list = listCandidateReleases(releases, repo);
  return list.length ? list[0] : null;
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

/** One asset's bytes as text (the API's asset address, the one redirect allowed to GitHub's asset hosts). */
async function fetchAsset(fetchJson, repo, id, { timeoutMs, maxBytes, signal }) {
  const url = `https://${API_HOST}/repos/${repo}/releases/assets/${id}`;
  const headers = { "User-Agent": USER_AGENT, Accept: "application/octet-stream" };
  // raw: the bytes as received (a fake fetch may answer with text, which is taken as its UTF-8 bytes)
  const got = await Promise.resolve().then(() => fetchJson(url, { headers, timeoutMs, maxBytes, signal, redirectHosts: ASSET_HOSTS, raw: true }));
  const buf = Buffer.isBuffer(got) ? got : typeof got === "string" ? Buffer.from(got, "utf8") : null;
  if (buf === null) throw new UpdateError("bad_answer");
  if (buf.length > maxBytes) throw new UpdateError("too_large");
  return buf;
}

/** The signed notice of a release: the parsed notice when it checks, null when an asset is missing or the signature or the content does not check. */
async function verifiedNotice(release, { fetchJson, repo, publicKey, timeoutMs, signal }) {
  const noticeId = release.assets[NOTICE_FILE];
  const sigId = release.assets[SIG_FILE];
  if (!noticeId || !sigId) return null;
  const body = await fetchAsset(fetchJson, repo, noticeId, { timeoutMs, maxBytes: releaseFile.MAX_FILE_BYTES, signal });
  const sig = await fetchAsset(fetchJson, repo, sigId, { timeoutMs, maxBytes: releaseFile.MAX_SIG_BYTES, signal });
  const bytes = body;
  if (!releaseFile.verifyDetached(publicKey, bytes, sig.toString("latin1"))) return null;
  let notice;
  try {
    notice = releaseFile.parseReleaseJson(bytes);
  } catch {
    return null;
  }
  if (notice.version !== release.latest) return null;
  return notice;
}

/**
 * @param {object} p
 * @param {(url:string, opts:{headers:object, timeoutMs:number, maxBytes:number, signal:AbortSignal, redirectHosts?:string[]}) => Promise<string|object>} p.fetchJson
 * @param {string} p.currentVersion "x.y.z"
 * @param {boolean} p.anyActive true while any swap is active: nothing is asked then
 * @param {string|null} p.repo "owner/name", or null when the program was built without one
 * @param {string} [p.publicKey] the release public key (base64); the compiled-in one by default; empty means not configured
 * @returns {Promise<{state:"none"|"newer"|"unverified"|"skipped_active"|"error", latest?:string, url?:string, note?:string,
 *   unsafeForNewSwaps?:boolean, unsafeNote?:string|null, reason?:string}>}
 */
async function checkForUpdate({ fetchJson, currentVersion, anyActive, repo, publicKey = releaseKey.PUBLIC_KEY_B64, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES }) {
  if (anyActive) return { state: "skipped_active" };
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return { state: "error", reason: "not_configured" };
  const current = parseVersion(currentVersion);
  if (current === null) return { state: "error", reason: "bad_version" };
  // fail closed: without a valid compiled-in key nothing is asked and no version is ever announced
  if (releaseFile.publicKeyObject(publicKey) === null) return { state: "error", reason: "key_not_configured" };
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new UpdateError("timeout"));
      }, timeoutMs);
    });
    const work = async () => {
      const listUrl = `https://${API_HOST}/repos/${repo}/releases?per_page=${PAGE_SIZE}`;
      const headers = { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" };
      const answer = await fetchJson(listUrl, { headers, timeoutMs, maxBytes, signal: controller.signal });
      const firstList = readAnswer(answer, maxBytes);
      const candidates = listCandidateReleases(firstList, repo);
      const release = candidates.length ? candidates[0] : null;
      if (release === null) return { state: "none", unsafeForNewSwaps: false, unsafeNote: null };
      let notice = null;
      let topError = null;
      try {
        notice = await verifiedNotice(release, { fetchJson, repo, publicKey, timeoutMs, signal: controller.signal });
      } catch (e) {
        topError = e; // an asset that cannot be read says nothing about the signature: the older signed notices still count
      }
      const newer = compareVersions(release.version, current) > 0;
      if (notice === null) {
        // An unsigned higher tag must not shadow a lower release's signed oldest_safe_version floor.
        let fallbackNotice = null;
        let fallbackOldest = null;
        const seen = new Set([release.latest]);
        const scan = async (list) => {
          for (const lower of list) {
            if (seen.has(lower.latest)) continue;
            seen.add(lower.latest);
            let n = null;
            try {
              n = await verifiedNotice(lower, { fetchJson, repo, publicKey, timeoutMs, signal: controller.signal });
            } catch {
              n = null;
            }
            if (n === null) continue;
            const parts = releaseFile.versionParts(n.oldest_safe_version);
            if (fallbackOldest === null || releaseFile.compareParts(parts, fallbackOldest) > 0) {
              fallbackOldest = parts;
              fallbackNotice = n;
            }
          }
        };
        await scan(candidates.slice(1));
        // Ten unsigned tags must not push a signed notice out of view either: while none has been found and the last page was full, a few more pages are read.
        // A page that cannot be read ends the search (fail safe: the floor the program already remembers stays).
        let pageFull = Array.isArray(firstList) && firstList.length >= PAGE_SIZE;
        for (let page = 2; fallbackNotice === null && pageFull && page < 2 + MAX_EXTRA_PAGES; page += 1) {
          let more;
          try {
            const next = readAnswer(await fetchJson(`${listUrl}&page=${page}`, { headers, timeoutMs, maxBytes, signal: controller.signal }), maxBytes);
            pageFull = Array.isArray(next) && next.length >= PAGE_SIZE;
            more = listCandidateReleases(next, repo);
          } catch {
            break;
          }
          await scan(more);
        }
        const fallbackFlags = fallbackNotice
          ? (() => {
              const unsafe = releaseFile.compareParts(current, fallbackOldest) < 0;
              return {
                unsafeForNewSwaps: unsafe,
                unsafeNote: unsafe ? fallbackNotice.note : null,
                signedOldest: { version: fallbackNotice.oldest_safe_version, note: fallbackNotice.note },
              };
            })()
          : null;
        if (topError !== null) return fallbackFlags ? { state: "error", reason: reasonOf(topError), ...fallbackFlags } : { state: "error", reason: reasonOf(topError) };
        if (newer) return fallbackFlags ? { state: "unverified", latest: release.latest, url: release.url, ...fallbackFlags } : { state: "unverified", latest: release.latest, url: release.url };
        return fallbackFlags ? { state: "none", ...fallbackFlags } : { state: "none", unsafeForNewSwaps: false, unsafeNote: null };
      }
      const oldest = releaseFile.versionParts(notice.oldest_safe_version);
      const unsafe = releaseFile.compareParts(current, oldest) < 0;
      // signedOldest: what only a valid signature can say; the checker keeps the highest one it ever saw (updatecheck.js)
      const flags = { unsafeForNewSwaps: unsafe, unsafeNote: unsafe ? notice.note : null, signedOldest: { version: notice.oldest_safe_version, note: notice.note } };
      if (newer) return { state: "newer", latest: release.latest, url: release.url, note: notice.note, sha256: notice.sha256, ...flags };
      return { state: "none", ...flags };
    };
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } catch (e) {
    return { state: "error", reason: reasonOf(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The real fetch, on node's https (a fake module is passed by the tests). One request to api.github.com, status 200 only, no
 * cookie. A redirect is refused, except when the caller names redirectHosts (the notice assets): then one hop to https, the
 * default port, no credentials, a host exactly in that list, and the second request carries the user agent only.
 */
function createHttpsFetchJson({ https = require("https") } = {}) {
  return (url, { headers, timeoutMs, maxBytes, signal, redirectHosts, raw }) =>
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
      const hosts = Array.isArray(redirectHosts) ? redirectHosts.filter((h) => ASSET_HOSTS.includes(h)) : [];
      let current = null;
      const stopAll = () => {
        if (current) current.destroy();
      };
      const get = (target, safeHeaders, hopsLeft) => {
        const req = https.get({ protocol: "https:", host: target.hostname, path: target.pathname + target.search, headers: safeHeaders, agent: false, timeout: timeoutMs }, (res) => {
          const code = res.statusCode;
          if (hopsLeft > 0 && hosts.length > 0 && [301, 302, 303, 307, 308].includes(code)) {
            res.resume();
            let next = null;
            try {
              next = new URL(String(res.headers && res.headers.location));
            } catch {
              next = null;
            }
            if (!next || next.protocol !== "https:" || next.port !== "" || next.username !== "" || next.password !== "" || !hosts.includes(next.hostname)) {
              reject(new UpdateError("network"));
              return;
            }
            get(next, { "User-Agent": safeHeaders["User-Agent"] }, hopsLeft - 1);
            return;
          }
          if (code !== 200) {
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
          res.on("end", () => resolve(raw === true ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8")));
          res.on("error", () => reject(new UpdateError("network")));
        });
        current = req;
        req.on("timeout", () => {
          req.destroy();
          reject(new UpdateError("timeout"));
        });
        req.on("error", () => reject(new UpdateError("network")));
      };
      get(u, { "User-Agent": headers["User-Agent"], Accept: headers.Accept }, hosts.length > 0 ? 1 : 0);
      if (signal) {
        const stop = () => {
          stopAll();
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

/** The signed installer hashes as a plain list of { name, sha256 }, only well-formed entries (the record is a file on disk). */
function cleanSums(m) {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return [];
  const out = [];
  for (const k of Object.keys(m).slice(0, 16)) if (/^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/.test(k) && typeof m[k] === "string" && /^[0-9a-f]{64}$/.test(m[k])) out.push({ name: k, sha256: m[k] });
  return out;
}

/** The shape /api/program shows: state, latest, url, the fixed words, the signed note and the unsafe flag. */
function describe(result) {
  const unsafe = result.unsafeForNewSwaps === true;
  const flags = { unsafeForNewSwaps: unsafe, unsafeNote: unsafe && typeof result.unsafeNote === "string" ? result.unsafeNote : null };
  if (result.state === "newer") return { state: "newer", latest: result.latest, url: result.url, text: NOTICE_TEXT, note: typeof result.note === "string" ? result.note : null, sha256: cleanSums(result.sha256), ...flags };
  if (result.state === "unverified") return { state: "unverified", latest: result.latest, url: result.url, text: UNVERIFIED_TEXT, ...flags };
  if (result.state === "error" && result.reason === "key_not_configured") return { state: "release_check_not_configured", latest: null, url: null, text: KEY_MISSING_TEXT, ...flags };
  return { state: result.state, latest: null, url: null, ...flags };
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
  cleanSums,
  UNVERIFIED_TEXT,
  KEY_MISSING_TEXT,
  ASSET_HOSTS,
  API_HOST,
};
