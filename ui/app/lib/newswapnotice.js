"use strict";
/*
 * R2, the signed "oldest safe version" notice, as the server sees it. One reader for every place that refuses to START a swap (the form, a board slot, Bob's invitation save, and the
 * `prepare` and `join` steps while the role's swap file does not exist yet). It never refuses a running swap, a refund, a recovery, a sweep, a tick, a watch or a step of a swap file that
 * exists: callers ask only at the moment a swap would be made.
 *
 *   read(program) -> { unsafe, note, note_unreadable, why }
 *     unsafe           true only when the program's update status says `unsafeForNewSwaps === true` (anything missing, or a status that throws, is false)
 *     note             the signed note, or null; the rules of the release file's own reader are re-checked here: at most 280 characters and no control, format, private-use, unassigned or
 *                      line-separator character. A note that fails is null and `note_unreadable` is true (the page then says "The notice's text cannot be shown.")
 *     why              the reason text of a refusal, or null when new swaps are allowed
 *
 * Display and entry refusal only: nothing here changes a step, a gate or the bytes an approval hashes.
 */

const MAX_NOTE_CHARS = 280;
const REASON = "New swaps are paused in this version by a signed security notice. Update the program to start one. Swaps already running go on as usual.";
const BAD_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/** The note when it passes the release file's rules, else null. */
function cleanNote(note) {
  if (typeof note !== "string" || note.length === 0) return null;
  if ([...note].length > MAX_NOTE_CHARS) return null;
  if (BAD_CHAR.test(note)) return null;
  return note;
}

function read(program) {
  let u = null;
  try {
    u = program && typeof program.updateStatus === "function" ? program.updateStatus() : null;
  } catch {
    u = null;
  }
  const unsafe = !!u && typeof u === "object" && u.unsafeForNewSwaps === true;
  if (!unsafe) return { unsafe: false, note: null, note_unreadable: false, why: null };
  const note = cleanNote(u.unsafeNote);
  return { unsafe: true, note, note_unreadable: note === null, why: REASON };
}

module.exports = { read, cleanNote, REASON, MAX_NOTE_CHARS };
