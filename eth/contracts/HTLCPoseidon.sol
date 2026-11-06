// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Poseidon2b} from "./Poseidon2b.sol";

/**
 * @title HTLCPoseidon
 * @notice Hash-time-locked contract for native ETH whose lock is a Parano1d ADDRESS:
 *         claim succeeds when Poseidon2b.addr(secret) == lockAddr. Same shape and safety
 *         rules as HTLC.sol (fixed receiver, disjoint claim/refund windows, deterministic
 *         lock id, re-entrancy guard, checks-effects-interactions); only the hash differs.
 *
 * WHY
 * ---
 *   On Parano1d the claim authority of the swap contract is A = Addr(s). Locking the ETH
 *   leg on the same A (instead of SHA-256(s)) means one secret trivially satisfies both
 *   legs, so Bob needs no zero-knowledge equivalence proof before locking: he just checks
 *   that lockAddr equals the claim authority committed in Alice's Parano1d contract.
 *
 * ENCODING (the Parano1d side MUST match exactly)
 * ------------------------------------------------
 *   - secret = exactly 32 raw bytes (a bytes32); s_lo = u128 LE of bytes 0..16, s_hi =
 *     u128 LE of bytes 16..32 (see Poseidon2b.sol).
 *   - lockAddr = the 32 address bytes, i.e. the payload of the bech32m `o1...` string,
 *     with the first byte as the most significant byte of the bytes32.
 *   - lockAddr == Addr(s), which is what Parano1d prints as the address of secret s
 *     (raw variant). For the stock-wallet variant lock on Addr(Derive(m,0)) and reveal m;
 *     this contract verifies Addr(s) only, so the stock variant must pass s = Derive(m,0)
 *     ... which the stock wallet never exposes. Use HTLCPoseidon for the RAW variant.
 *
 * TIMELOCK RULES, LOCK ID, HAZARDS: identical to HTLC.sol. The preimage is public once
 * claimed (event + storage); it pays the fixed receiver, so a mempool watcher gains nothing.
 *
 * COST: claim() computes one Poseidon2b permutation in the EVM. Measured (Hardhat, solc 0.8.24,
 * optimizer 200): Poseidon2b.addr 428,747 gas; claim() 519,537 gas as a transaction, versus
 * 88,926 for HTLC.sol (SHA-256). Always send claim() with an explicit gas limit (>= 650,000):
 * an under-provisioned claim reverts with the secret already public. See docs/poseidon-evm.md.
 */
contract HTLCPoseidon {
    struct Lock {
        address sender;
        address receiver;
        uint256 amount;
        bytes32 lockAddr;
        uint256 timelock;
        bool claimed;
        bool refunded;
        bytes32 preimage; // zero until claimed
    }

    mapping(bytes32 => Lock) private _locks;

    event Locked(
        bytes32 indexed lockId,
        address indexed sender,
        address indexed receiver,
        uint256 amount,
        bytes32 lockAddr,
        uint256 timelock
    );
    event Claimed(bytes32 indexed lockId, bytes32 preimage);
    event Refunded(bytes32 indexed lockId);

    error ZeroAmount();
    error ZeroReceiver();
    error TimelockNotInFuture();
    error LockAlreadyExists();
    error LockNotFound();
    error InvalidPreimage();
    error TimelockExpired();
    error TimelockNotExpired();
    error AlreadyClaimed();
    error AlreadyRefunded();
    error NotSender();
    error TransferFailed();
    error Reentrancy();

    uint256 private _status = 1; // 1 = not entered, 2 = entered

    modifier nonReentrant() {
        if (_status == 2) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }

    /// @notice Compute the id a lock with these parameters will have.
    function computeLockId(
        address sender,
        address receiver,
        uint256 amount,
        bytes32 lockAddr,
        uint256 timelock
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(sender, receiver, amount, lockAddr, timelock));
    }

    /// @notice Addr(s) as this contract computes it, so a counterparty can check the
    ///         encoding against the Parano1d node before locking.
    function addrOf(bytes32 secret) external pure returns (bytes32) {
        return Poseidon2b.addr(secret);
    }

    /**
     * @notice Lock msg.value for `receiver` under `lockAddr` until `timelock`.
     * @param lockAddr Parano1d address Addr(s) of the 32-byte secret (see contract docs).
     * @param timelock Absolute Unix timestamp; must be strictly in the future.
     * @param receiver Fixed payee on claim.
     */
    function newLock(
        bytes32 lockAddr,
        uint256 timelock,
        address payable receiver
    ) external payable nonReentrant returns (bytes32 lockId) {
        if (msg.value == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (timelock <= block.timestamp) revert TimelockNotInFuture();

        lockId = computeLockId(msg.sender, receiver, msg.value, lockAddr, timelock);
        if (_locks[lockId].sender != address(0)) revert LockAlreadyExists();

        _locks[lockId] = Lock({
            sender: msg.sender,
            receiver: receiver,
            amount: msg.value,
            lockAddr: lockAddr,
            timelock: timelock,
            claimed: false,
            refunded: false,
            preimage: bytes32(0)
        });

        emit Locked(lockId, msg.sender, receiver, msg.value, lockAddr, timelock);
    }

    /**
     * @notice Reveal the secret and pay the receiver. Callable by anyone; funds always go
     *         to the lock's fixed receiver. Costs one Poseidon2b permutation of gas.
     */
    function claim(bytes32 lockId, bytes32 preimage) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.claimed) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (block.timestamp >= l.timelock) revert TimelockExpired();
        if (Poseidon2b.addr(preimage) != l.lockAddr) revert InvalidPreimage();

        // effects
        l.claimed = true;
        l.preimage = preimage;
        uint256 amount = l.amount;
        address receiver = l.receiver;

        emit Claimed(lockId, preimage);

        // interaction
        (bool ok, ) = payable(receiver).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Return the funds to the sender after the timelock, if unclaimed.
    function refund(bytes32 lockId) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (msg.sender != l.sender) revert NotSender();
        if (l.claimed) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (block.timestamp < l.timelock) revert TimelockNotExpired();

        // effects
        l.refunded = true;
        uint256 amount = l.amount;

        emit Refunded(lockId);

        // interaction
        (bool ok, ) = payable(l.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Full lock record. Reverts if the lock does not exist.
    function getLock(bytes32 lockId) external view returns (Lock memory) {
        Lock memory l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        return l;
    }
}
