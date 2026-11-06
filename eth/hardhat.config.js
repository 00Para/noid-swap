require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.24";

// Normally Hardhat downloads the native solc binary from binaries.soliditylang.org.
// If that download fails (offline / firewalled CI), fall back to the pure-JS
// compiler shipped in the `solc` npm package (same version, same output).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    try {
      return await runSuper();
    } catch (e) {
      console.warn(`[hardhat.config] native solc download failed (${e.message.split("\n")[0]}); using npm solc-js ${SOLC_VERSION}`);
      return {
        compilerPath: require.resolve("solc/soljson.js"),
        isSolcJs: true,
        version: SOLC_VERSION,
        longVersion: require("solc/package.json").version === SOLC_VERSION ? require("solc").version() : SOLC_VERSION,
      };
    }
  }
  return runSuper();
});

/** @type import('hardhat/config').HardhatUserConfig */
// Standalone `npx hardhat node` used as the local Ethereum leg of a swap run: when
// HARDHAT_INTERVAL_MINING_MS is set, empty blocks are mined at that interval so the chain
// clock keeps moving like a real network (transactions are still mined at once).
// Unset during `npx hardhat test`, so the tests are unaffected.
const intervalMs = Number(process.env.HARDHAT_INTERVAL_MINING_MS || 0);

module.exports = {
  networks: intervalMs > 0 ? { hardhat: { mining: { auto: true, interval: intervalMs } } } : {},
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
};
