"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { navigationAllowed, requestAllowed, stripFragment, originOf, DENY } = require("../lib/hardening");

const page = { allowedOrigin: "http://127.0.0.1:5000", pageUrl: "http://127.0.0.1:5000/#token=t" };

test("navigation: only the page's own URL, the fragment ignored", () => {
  assert.equal(navigationAllowed("http://127.0.0.1:5000/", page), true);
  assert.equal(navigationAllowed("http://127.0.0.1:5000/#other", page), true);
  assert.equal(navigationAllowed("http://127.0.0.1:5000/x", page), false);
  assert.equal(navigationAllowed("http://127.0.0.1:5000/?a=1", page), false);
  assert.equal(navigationAllowed("http://127.0.0.1:5001/", page), false);
  assert.equal(navigationAllowed("javascript:alert(1)", page), false);
  assert.equal(navigationAllowed("data:text/html,x", page), false);
  assert.equal(navigationAllowed("", page), false);
  assert.equal(navigationAllowed("http://127.0.0.1:5000/", DENY), false);
  assert.equal(navigationAllowed("http://127.0.0.1:5000/", null), false);
});

test("requests: same origin and inline data only; the file policy is prefix-exact", () => {
  assert.equal(requestAllowed("http://127.0.0.1:5000/a.js", page), true);
  assert.equal(requestAllowed("ws://127.0.0.1:5000/", page), false);
  assert.equal(requestAllowed("https://127.0.0.1:5000/", page), false);
  assert.equal(requestAllowed("data:image/svg+xml,x", page), true);
  assert.equal(requestAllowed("blob:http://127.0.0.1:5000/x", page), false);
  const file = { fileUrlPrefix: "file:///app/secret/" };
  assert.equal(requestAllowed("file:///app/secret/secret.css", file), true);
  assert.equal(requestAllowed("file:///app/secret/../x.js", file), false);
  assert.equal(requestAllowed("file:///app/secrets/x.js", file), false);
  assert.equal(requestAllowed("file:///etc/passwd", file), false);
  assert.equal(requestAllowed("http://127.0.0.1:5000/", file), false);
});

test("stripFragment", () => {
  assert.equal(stripFragment("http://a/b#c"), "http://a/b");
  assert.equal(stripFragment("nonsense"), null);
});

const scheme = { allowedOrigin: "no1d://app", pageUrl: "no1d://app/#token=t" };

test("originOf: the private scheme's origin is compared by hand, because the URL class gives the string null for it", () => {
  assert.equal(new URL("no1d://app/").origin, "null");
  assert.equal(originOf("no1d://app/x?y=1#z"), "no1d://app");
  assert.equal(originOf("no1d://app"), "no1d://app");
  assert.equal(originOf("no1d://app:80/"), "no1d://app:80");
  assert.equal(originOf("no1d://other/"), "no1d://other");
  assert.equal(originOf("no1d://u@app/"), null, "a user name: no origin");
  assert.equal(originOf("no1d://u:p@app/"), null);
  assert.equal(originOf("no1d:///x"), null, "no host");
  assert.equal(originOf("file:///x"), null);
  assert.equal(originOf("http://127.0.0.1:5000/x"), "http://127.0.0.1:5000");
  assert.equal(originOf("https://example.com/x"), "https://example.com");
  assert.equal(originOf("nonsense"), null);
  assert.equal(originOf(undefined), null);
  assert.equal(originOf(null), null);
});

test("the scheme page: navigation to itself only, requests to its origin only", () => {
  assert.equal(navigationAllowed("no1d://app/", scheme), true);
  assert.equal(navigationAllowed("no1d://app/#other", scheme), true);
  assert.equal(navigationAllowed("no1d://app/x", scheme), false);
  assert.equal(navigationAllowed("no1d://other/", scheme), false);
  assert.equal(navigationAllowed("http://app/", scheme), false);
  assert.equal(requestAllowed("no1d://app/operator.js", scheme), true);
  assert.equal(requestAllowed("no1d://app/api/program", scheme), true);
  assert.equal(requestAllowed("no1d://other/operator.js", scheme), false);
  assert.equal(requestAllowed("no1d://app:1/operator.js", scheme), false);
  assert.equal(requestAllowed("no1d://u@app/operator.js", scheme), false);
  assert.equal(requestAllowed("http://app/operator.js", scheme), false);
  assert.equal(requestAllowed("http://127.0.0.1:5000/a.js", scheme), false);
  assert.equal(requestAllowed("data:image/svg+xml,x", scheme), true);
  assert.equal(requestAllowed("blob:no1d://app/x", scheme), false);
  assert.equal(requestAllowed("no1d://app/operator.js", DENY), false);
  assert.equal(requestAllowed("no1d://app/operator.js", { fileUrlPrefix: "file:///app/secret/" }), false);
});
