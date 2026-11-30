"use strict";
/*
 * Path helpers that tell whether two spellings name the same file: a WSL share (\\wsl.localhost\Distro\home\u\x or //wsl$/Distro/...), a
 * Linux path as a helper sees it (/home/u/x; /mnt/c/Users/... is the Windows C:\Users\...), a Windows path (C:\Users\... or C:/Users/...).
 * Used to check that the folder the console READS is the folder the helpers get as $L, and that the object file fund.sh read (a Linux path) is
 * the one the console's terms came from (a Windows or UNC path).
 */

/**
 * A canonical string for a path, or null when it is not absolute. Windows paths compare case-insensitively ("win:c:/users/..."); a Linux path
 * carries the distro it lives in ("lin:ubuntu-24.04:/home/u/x"; "lin::/srv/x" with none).
 * @param {string} p
 * @param {string|null} [distro] the distro a plain Linux path belongs to
 */
function canonicalPath(p, distro) {
  if (typeof p !== "string" || !p) return null;
  let s = p.replace(/\\/g, "/").replace(/\/+$/g, "");
  const unc = /^\/\/wsl(?:\.localhost|\$)\/([^/]+)\/(.*)$/i.exec(s);
  if (unc) return `lin:${unc[1].toLowerCase()}:/${unc[2].replace(/\/{2,}/g, "/")}`;
  const drive = /^([A-Za-z]):\/(.*)$/.exec(s);
  if (drive) return `win:${drive[1].toLowerCase()}:/${drive[2].replace(/\/{2,}/g, "/").toLowerCase()}`;
  const mnt = distro ? /^\/mnt\/([a-z])\/(.*)$/.exec(s) : null;
  if (mnt) return `win:${mnt[1]}:/${mnt[2].replace(/\/{2,}/g, "/").toLowerCase()}`;
  if (s.startsWith("/") && !s.startsWith("//")) return `lin:${distro ? String(distro).toLowerCase() : ""}:${s.replace(/\/{2,}/g, "/")}`;
  return null;
}

/** True only when both paths canonicalize and the canonical forms are equal. */
function samePath(a, distroA, b, distroB) {
  const x = canonicalPath(a, distroA);
  const y = canonicalPath(b, distroB);
  return x !== null && y !== null && x === y;
}

module.exports = { canonicalPath, samePath };
