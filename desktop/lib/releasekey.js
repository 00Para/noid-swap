"use strict";
/*
 * The release key: the public half of the one Ed25519 key that signs every release's release.json (docs/release-key.md).
 *
 * PUBLIC_KEY_B64 is the raw 32-byte public key in base64 (44 characters), or the empty string while no key was generated.
 * With the empty string the update check never says "a newer version exists" and says the release check is not configured:
 * it fails closed. The owner makes the key on his own machine (scripts/release-key.js keygen) and pastes the one line the
 * script prints between the quotes below, in a reviewed commit; a program built from that commit then believes only files
 * signed by that key.
 */

const PUBLIC_KEY_B64 = "Thg9nhwwvqoKG4yOqiZM/PBeqT5LcrFFa7cKAHuqYxk=";

module.exports = { PUBLIC_KEY_B64 };
