"use strict";
/*
 * Window hardening (design 3, build spec 7.3). Takes the Electron module (or the parts it needs) as an argument; requires nothing from it.
 *
 * One guard per program. `install()` makes every webContents the program ever creates (the page, the secret window, a stray
 * devtools or webview) start under a DENY policy: no navigation, no new window, no permission, no download, no request. A window
 * then calls `apply(webContents, policy)` to say what it may load. Handlers read the policy at event time, so the order of the
 * two steps does not matter.
 */

const DENY = Object.freeze({ allowedOrigin: null, pageUrl: null, allowDevtools: false });

function parse(u) {
  try {
    return new URL(String(u));
  } catch {
    return null;
  }
}

/**
 * The origin of a URL, compared by hand: `new URL("no1d://app/").origin` is the string "null" for a scheme that is not one of the web's own, so `.origin`
 * cannot name the private scheme's page. For http(s) it is the usual origin; for any other scheme it is protocol + "//" + host (the port included), and a URL
 * with a user name or a password has no origin here (null: it never matches the allowed one).
 */
function originOf(u) {
  const x = typeof u === "string" ? parse(u) : u;
  if (!x || typeof x.protocol !== "string") return null;
  if (x.username !== "" || x.password !== "") return null;
  if (x.protocol === "http:" || x.protocol === "https:") return x.origin;
  if (x.host === "") return null;
  return `${x.protocol}//${x.host}`;
}

function stripFragment(u) {
  const x = parse(u);
  if (!x) return null;
  x.hash = "";
  return x.href;
}

/** The only navigation allowed: the page's own URL, fragment ignored. */
function navigationAllowed(url, policy) {
  if (!policy || !policy.pageUrl) return false;
  const a = stripFragment(url);
  const b = stripFragment(policy.pageUrl);
  return a !== null && b !== null && a === b;
}

/**
 * A sub-request (script, style, font, fetch): the page's own origin or an inline data URL. Never file://: both windows are served on the
 * private scheme (the console on no1d://app, the secret window on no1d://secret).
 */
function requestAllowed(url, policy) {
  const x = parse(url);
  if (!x || !policy) return false;
  if (x.protocol === "data:") return true; // inline, never the network
  if (x.protocol === "blob:" || x.protocol === "filesystem:") return false; // their origin is the creator's, but the page needs neither
  if (policy.allowDevtools && x.protocol === "devtools:") return true;
  if (policy.allowedOrigin && originOf(x) === policy.allowedOrigin) return true;
  return false;
}

function navUrl(event, rest) {
  if (typeof rest[0] === "string") return rest[0];
  if (event && typeof event.url === "string") return event.url;
  return "";
}

function createPolicyRegistry() {
  const byWc = new Map();
  const bySession = new WeakMap();
  return {
    set(wc, policy) {
      const p = Object.freeze({ ...DENY, ...policy });
      byWc.set(wc.id, p);
      if (wc.session && typeof wc.session === "object") bySession.set(wc.session, p);
      return p;
    },
    forWebContents(wc) {
      return byWc.get(wc.id) || DENY;
    },
    forSession(s) {
      return bySession.get(s) || DENY;
    },
    drop(wc) {
      byWc.delete(wc.id);
    },
  };
}

/** The only WebRTC policy that lets no page open a direct UDP path: it may use a proxy, and the program has none. */
const WEBRTC_POLICY = "disable_non_proxied_udp";

/** Fire and forget; a session or a build that cannot do it must not stop the program (the request handlers still refuse every address). */
function callQuietly(fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    /* nothing more can be done */
  }
}

function createGuard(electron) {
  const registry = createPolicyRegistry();
  const seenWc = new WeakSet();
  const seenSession = new WeakSet();

  function applySession(session) {
    if (!session || seenSession.has(session)) return;
    seenSession.add(session);
    // No proxy of the system or of an environment variable: nothing of the program may take a detour through one. The call comes before any
    // request, because a session is first seen when its first web contents is made (or at ready, for the default one).
    if (typeof session.setProxy === "function") callQuietly(() => session.setProxy({ mode: "direct" }));
    if (typeof session.setPermissionRequestHandler === "function") session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    if (typeof session.setPermissionCheckHandler === "function") session.setPermissionCheckHandler(() => false);
    if (typeof session.setDevicePermissionHandler === "function") session.setDevicePermissionHandler(() => false);
    if (session.webRequest && typeof session.webRequest.onBeforeRequest === "function") {
      session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !requestAllowed(details && details.url, registry.forSession(session)) }));
    }
    if (typeof session.on === "function") {
      session.on("will-download", (event) => event.preventDefault());
      for (const name of ["select-hid-device", "select-usb-device"]) session.on(name, (event, _d, cb) => { event.preventDefault(); if (typeof cb === "function") cb(); });
      session.on("select-serial-port", (event, _p, _wc, cb) => { event.preventDefault(); if (typeof cb === "function") cb(""); });
    }
  }

  function applyWebContents(wc) {
    if (!wc || seenWc.has(wc)) return;
    seenWc.add(wc);
    if (typeof wc.setWindowOpenHandler === "function") wc.setWindowOpenHandler(() => ({ action: "deny" }));
    if (typeof wc.setWebRTCIPHandlingPolicy === "function") callQuietly(() => wc.setWebRTCIPHandlingPolicy(WEBRTC_POLICY));
    for (const ev of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      wc.on(ev, (event, ...rest) => {
        if (!navigationAllowed(navUrl(event, rest), registry.forWebContents(wc))) event.preventDefault();
      });
    }
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.on("select-bluetooth-device", (event, _list, cb) => { event.preventDefault(); if (typeof cb === "function") cb(""); });
    wc.on("destroyed", () => registry.drop(wc));
    applySession(wc.session);
  }

  return {
    registry,
    /** Every webContents created from now on starts under DENY. */
    install() {
      electron.app.on("web-contents-created", (_event, wc) => applyWebContents(wc));
    },
    applySession,
    /** Say what one webContents may load: { allowedOrigin, pageUrl, allowDevtools }. */
    apply(wc, policy) {
      registry.set(wc, policy);
      applyWebContents(wc);
    },
  };
}

module.exports = { createGuard, WEBRTC_POLICY, createPolicyRegistry, navigationAllowed, requestAllowed, stripFragment, originOf, DENY };
