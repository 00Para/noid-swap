"use strict";
/* The help text the menu shows (a message box of the main process). Fixed text; nothing in it is built from data. */

const HELP_TITLE = "About No1d Swap";

const HELP_PARAGRAPHS = Object.freeze([
  "No1d Swap swaps NOID for Ethereum (or the other way round) with a hash-time lock on both sides: either both legs settle, or both are refunded. This version works on test networks only.",
  "Your recovery code opens the swaps made on this computer if its key store is lost. Keep it on paper. Anyone with the code and your run folders can open your swaps.",
  "If this program no longer starts, the recovery code and a whole run folder still open that swap by hand with swap-cli: the public source's desktop/README.md says how, in \"By hand, without the program\".",
  "What protects the secrets is the system key store. It stops other user accounts, a stolen disk and a copied run folder. It does not stop another program that runs as you; the same goes for the program's integrity checks.",
  "The program needs the Parano1d wallet app running on this computer (its node answers on 127.0.0.1:9601), and it keeps the computer awake while coins are in a contract. A closed laptop lid on battery can still sleep a Mac.",
  "Classic and sha256 runs, and the old terminal console, still work from the terminal. This program does not run them.",
  "Windows may not write a folder change to disk before a power cut. A swap file is written before anything is sent, which protects against a crash, but not certainly against a power cut.",
  "This build is not signed by a publisher, so the system may warn you when you install it. Check the file's sha256 and its build provenance on the release page first.",
]);

module.exports = { HELP_TITLE, HELP_PARAGRAPHS };
