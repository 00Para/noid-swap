# The release key

One small key, kept offline, signs every release. The program believes "a newer version exists" only when the signature
checks, and a signed notice can tell it "this version is no longer safe for new swaps".

## Why it exists, in plain words

This project has no company, no name and no code-signing certificate (a certificate proves a name, and there is none to prove).
Without something else, the only proof that a download is the real one is the hosting account: if that account were taken
over, the installer, its hash file and the "new version" notice would all change together, and nobody could tell.

So the owner keeps **one signing key**, outside the hosting account. A *signature* is a short code that only the holder of the
private key can make for a given file, and that anyone holding the matching public key can check. The public key is written
into the program (`desktop/lib/releasekey.js`) and into this repository. A taken-over hosting account can still put up a bad
file, but it cannot make a valid signature for it.

## What is signed

Not the installers themselves (they are large and differ by platform) but a small file, `release.json`, that lists them:

```json
{
  "product": "No1d Swap",
  "version": "0.2.0",
  "oldest_safe_version": "0.1.5",
  "note": "One sentence for people who run an older version.",
  "sha256": {
    "No1d-Swap-Setup-0.2.0.exe": "<64 lower-case hex characters>",
    "No1d-Swap-0.2.0-arm64.dmg": "<64 lower-case hex characters>"
  }
}
```

The signature is a second file, `release.json.sig`: the base64 text of the 64-byte Ed25519 signature over the exact bytes of
`release.json`. Rules (the program and the signing script apply the same strict reader, `desktop/lib/releasefile.js`):

- exactly these five keys, nothing else; `product` is `No1d Swap`;
- `version` and `oldest_safe_version` are `x.y.z` (digits only), and the oldest safe version is not above the version;
- `note` is one sentence, 1 to 280 characters, no control characters;
- `sha256` lists 1 to 16 plain file names (no folders), each with the 64 lower-case hex characters of that file's SHA-256;
- the file is at most 8 KB.

## What the program does with it

After it reads GitHub's list of releases (the same one request as before) the update check fetches the newest release's
`release.json` and `release.json.sig` through GitHub's asset address on `api.github.com`: no cookie, no token, the generic
user agent, 8 KB and 512 bytes at most, one redirect allowed and only to GitHub's own asset hosts
(`objects.githubusercontent.com`, `release-assets.githubusercontent.com`). It checks the signature with the compiled-in key,
parses the file strictly and requires its `version` to be the release's own tag. Then:

| What it finds | What the program says |
|---|---|
| A newer release with a valid signed notice | "newer version", with the signed note and each installer's file name with its signed SHA-256: the user compares the installer's SHA-256 with that signed value (never with the value on the release page, which the hosting account controls) and installs by hand |
| A newer release with a missing or bad signature, or a bad file | "A newer release is listed but its signature does not check: do not install it." It is never presented as an update. |
| No release key compiled in (the state of the repository until the owner makes the key) | The check asks nothing and says the release check is not configured. It never shows "newer version". |
| The running version is below the signed `oldest_safe_version` | `unsafeForNewSwaps` is true, with the signed `note` as `unsafeNote`. The program keeps, per running version, the highest signed `oldest_safe_version` it ever saw: only a valid signature raises it, and a failed check, an unsigned, badly signed or duplicated release or an older signed notice never lowers it. |

The program still never downloads or installs anything.

### The hook for "unsafe for new swaps"

`createUpdateChecker(...).status()` (what `program.updateStatus()` returns to the console server) now always carries
`unsafeForNewSwaps` (boolean) and `unsafeNote` (the signed sentence, or null). The console server can use them later to refuse to
**start a new swap** and to show the sentence. They must never block a running swap, a refund, a recovery or a sweep, so a wrong
or replayed notice can at worst delay new swaps. Notes for whoever wires it:

- `ui/app/server.js` builds the page's `update` object from `state`, `latest` and `url` only; add the two fields there, and use
  `unsafeForNewSwaps` in the `new_swap_allowed` answer.
- A failed check keeps a flag that is already known. A program update (another version than the one that wrote the record in
  `state.json`) discards the record, and the next start checks at once, so a fixed build is never flagged by an old answer.
- The flag exists only after a check that reached GitHub; with the check set to "off" it is whatever the last check left.

## Making the key (once, on a machine you trust, ideally offline)

```
node desktop/scripts/release-key.js keygen --out /path/outside/the/repository/release-key
```

The script asks for a passphrase twice (at least 12 characters) in your own terminal. It is read without echo and never from a
command-line argument or an environment variable. It writes `release-key.enc.json` (the private key, encrypted with the
passphrase by scrypt and AES-256-GCM) and prints the public key in one line. It refuses to write inside
a repository (this one, or any folder under a `.git`) and refuses to overwrite a key file. It proves that the new file opens with the
passphrase and signs correctly before it writes anything.

What protects the file: the passphrase (the file is useless without it), and on Linux and macOS the file mode `0600`. On Windows
the mode bits do nothing, so put the file in a folder only your account can read (or on an encrypted drive or an offline stick)
and rely on the passphrase. `.gitignore` lists `release-key.enc.json` and `*.enc.json` so that an accidental `git add` skips it.

1. Make **two copies** of `release-key.enc.json` on offline media kept in different places, and keep the passphrase somewhere
   that is not the same place (a password manager's secure note is fine). A key file without its passphrase is useless, and a
   passphrase without the file is too.
2. Put the printed line between the quotes of `PUBLIC_KEY_B64` in `desktop/lib/releasekey.js`, review it, and commit it. Publish
   the same line somewhere that is not the hosting account (the project's other channels), so a changed line is noticed.
3. Only a program built from that commit announces updates.

## Making a release

1. The build makes the installers and `SHA256SUMS.txt` as today.
2. Write `release.json` by hand (the version, the oldest version you still consider safe for new swaps, one sentence, and the
   SHA-256 of each installer from `SHA256SUMS.txt`). Normally `oldest_safe_version` stays where it was.
3. Sign it, on your machine, in your own terminal:

   ```
   node desktop/scripts/release-key.js sign --key /path/to/release-key.enc.json --in release.json
   ```

   The script checks the file's format, refuses a notice whose `version` is not the one in `desktop/package.json` and (once a
   public key is compiled into `desktop/lib/releasekey.js`) a key file whose public key is not that one, warns when a hash of the
   notice is not in a `SHA256SUMS.txt` beside it, shows its sha256 and its content, asks for the passphrase and writes
   `release.json.sig`. Read what it shows before typing the passphrase: that is what you are signing.
4. Attach `release.json` and `release.json.sig` to the release (both under exactly these names) next to the installers.

To warn every installed copy that an older version should not start new swaps: publish a release whose `oldest_safe_version`
is the first safe one and whose `note` says why. Copies below it show the flag at their next check.

## How anyone checks a download

With the public key (from the repository, `desktop/lib/releasekey.js`, and the project's other channels):

```
node desktop/scripts/release-key.js verify --pub <PUBLIC KEY> --in release.json --sig release.json.sig
```

It prints `OK` and exits 0, or says the signature does not match. Then compute the installer's SHA-256 (`sha256sum FILE`,
`shasum -a 256 FILE`, or `Get-FileHash FILE` on Windows) and compare it with the entry for that file name in `release.json`. The
build provenance attestation on the release page remains a second, independent check.

## Limits (what this does not do)

- **A lost key** (file or passphrase) cannot be recovered. Nobody can sign for the old key again: a new key is made, its public
  half goes into a new program version, and people install that version by hand, checking it by the other means (build
  provenance, the project's other channels). Programs that already run the old key never announce the new version, and they cannot
  tell it from a forgery: for the real new release they show "A newer release is listed but its signature does not check: do not
  install it." People must get the new version by hand and check it by those other means. This is why there are two backups, and
  why a planned rotation should be announced on every channel first.
- **A stolen key file** is protected by its passphrase, not more. A stolen key plus the passphrase plus the hosting account can
  ship a bad release and announce it. If the key is thought stolen, say so on every channel and move to a new key as above.
- **The hosting account alone** can no longer make the program announce a bad version, but it can still hide a real one (serve an
  older signed notice, or none): the program then says nothing new. A replayed old notice cannot name a version newer than the
  one it was signed for, and its `oldest_safe_version` can only be one that was once true.
- The signature proves who made the file, not that the file is good. Anyone reading the code and the build remains the check on
  that.
- Nothing is signed for the installers on Windows or macOS themselves: they stay unsigned for the operating system, and the
  operating system's warnings remain.
