"use strict";
/* Keep-awake (build spec 7.4): hold one `prevent-app-suspension` block while any swap has coins in a contract. Idempotent. */

function createKeepAwake({ powerSaveBlocker }) {
  let id = null;
  return {
    update(list) {
      const inContract = Array.isArray(list) && list.some((s) => s && s.in_contract === true);
      if (inContract && id === null) {
        id = powerSaveBlocker.start("prevent-app-suspension");
      } else if (!inContract && id !== null) {
        const held = id;
        id = null;
        powerSaveBlocker.stop(held);
      }
    },
    held: () => id !== null,
  };
}

module.exports = { createKeepAwake };
