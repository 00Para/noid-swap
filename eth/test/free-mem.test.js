"use strict";
// Unit tests of the vm_stat parser behind the memory guards (test/helpers/free-mem.js). No chain involved.
const { expect } = require("chai");
const { parseVmStat, availableMemBytes } = require("./helpers/free-mem.js");

const SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5000.
Pages active:                            100000.
Pages inactive:                           90000.
Pages speculative:                         2000.
Pages throttled:                              0.
Pages wired down:                         70000.
Pages purgeable:                           3000.
"Translation faults":                  12345678.
Pages copy-on-write:                     234567.
`;

describe("free-mem: parseVmStat", () => {
  it("sums free, inactive, speculative and purgeable pages times the page size", () => {
    expect(parseVmStat(SAMPLE)).to.equal((5000 + 90000 + 2000 + 3000) * 16384);
  });

  it("reads another page size from the header line", () => {
    const text = SAMPLE.replace("16384", "4096");
    expect(parseVmStat(text)).to.equal(100000 * 4096);
  });

  it("returns null for malformed input", () => {
    expect(parseVmStat("")).to.equal(null);
    expect(parseVmStat("not vm_stat output")).to.equal(null);
    expect(parseVmStat(undefined)).to.equal(null);
    // header present but a counted line is missing
    expect(parseVmStat(SAMPLE.replace(/^Pages purgeable:.*$/m, ""))).to.equal(null);
    // header missing
    expect(parseVmStat(SAMPLE.replace(/\(page size of 16384 bytes\)/, ""))).to.equal(null);
    // page size zero
    expect(parseVmStat(SAMPLE.replace("16384", "0"))).to.equal(null);
    // a count that is not a number
    expect(parseVmStat(SAMPLE.replace("5000.", "many."))).to.equal(null);
  });
});

describe("free-mem: availableMemBytes", () => {
  it("returns a positive number on this machine", () => {
    const n = availableMemBytes();
    expect(n).to.be.a("number");
    expect(n).to.be.greaterThan(0);
  });
});
