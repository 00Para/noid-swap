// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Poseidon2b} from "./Poseidon2b.sol";

/**
 * @title HTLCPoseidonV2
 * @notice Hash-time-locked contract for native ETH whose lock is a Parano1d ADDRESS: claim
 *         succeeds when Poseidon2b.addr(secret) == lockAddr. Ethereum half of a NOID <-> ETH
 *         atomic swap in which the ETH leg is locked on A = Addr(s), the same 32 bytes that are
 *         the claim authority of the Parano1d lock, so no zero-knowledge equivalence proof is
 *         needed (docs/poseidon-leg.md). Production version of the HTLCPoseidon prototype.
 *
 * DIFFERENCES FROM HTLC.sol (all deliberate; everything else is line-for-line the same)
 * -----------------------------------------------------------------------------------
 *   1. The hashlock is lockAddr = Addr(secret) (Poseidon2b), not SHA-256(secret).
 *   2. claim() checks the timelock BEFORE it pays for the permutation, so an expired claim fails
 *      cheaply (HTLC.sol checks the hash first; the two windows are still disjoint and exhaustive).
 *   3. claim() reverts BadCalldataLength unless the calldata is exactly 68 bytes (selector, lock
 *      id, 32-byte secret). HTLC.sol silently ignores trailing bytes; here the secret is exactly
 *      32 bytes and nothing else is accepted.
 *   4. claim() reverts InsufficientGas (before any state change and before the permutation) when
 *      fewer than MIN_CLAIM_GAS gas are left. See COST AND GAS below.
 *   5. There is NO view that computes Addr(secret). Such a function invites an eth_call with the
 *      live secret on a remote node, which would leak it before the counterparty has locked.
 *      Compute Addr locally with the reference crate (equiv-ref) and compare with this
 *      contract's output only on public test vectors, in a test deployment.
 *
 * ENCODING (the Parano1d side MUST match exactly)
 * -----------------------------------------------
 *   - secret = exactly 32 raw bytes (a bytes32); s_lo = u128 LE of bytes 0..16, s_hi = u128 LE
 *     of bytes 16..32 (see Poseidon2b.sol).
 *   - lockAddr = the 32 address bytes, i.e. the payload of the bech32m `o1...` string, with the
 *     first byte as the most significant byte of the bytes32.
 *   - lockAddr == Addr(s), the address Parano1d prints for the raw secret s. RAW VARIANT ONLY:
 *     the stock wallet's address is Addr(Derive(m, 0)) and would need three more permutations
 *     (about 1.7 M gas per claim); not supported here.
 *
 * TIMELOCK RULES, LOCK ID, HAZARDS: identical to HTLC.sol.
 *   claim() only while block.timestamp < timelock; refund() only when block.timestamp >= timelock.
 *   lockId = keccak256(abi.encodePacked(sender, receiver, amount, lockAddr, timelock)).
 *   Funds are paid with a low-level call to the fixed receiver (an EOA in the swap tool). A
 *   receiver that rejects ETH makes claim() revert with the secret in its calldata; the funds stay
 *   until refund(). The preimage is public once used (calldata, storage, event); it pays the fixed
 *   receiver, so a mempool watcher gains nothing by copying it.
 *
 * COST AND GAS
 * ------------
 *   One Poseidon2b permutation runs inside claim(): about 0.43 M gas, 0.50 M to 0.55 M for the whole
 *   transaction (measured numbers in docs/poseidon-leg.md). Send claim() with an explicit gas limit
 *   of at least RECOMMENDED_CLAIM_GAS_LIMIT and simulate it on your own node first. A claim that
 *   runs out of gas, or reverts with InsufficientGas, still published the secret in its calldata:
 *   the lock stays claimable, so re-send with enough gas and a sufficient fee. The InsufficientGas
 *   check does not prevent that disclosure; it only turns "out of gas somewhere in the middle" into
 *   one early, named failure and guarantees that a call that passes the check can finish an
 *   honest payout to an EOA.
 */
contract HTLCPoseidonV2 {
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

    /// Gas that must be left when claim() reaches the permutation (checked after the cheap
    /// validations). The work after the check needs at most about 510,000 (permutation, both storage
    /// writes, the event, and the payout to a receiver account that does not exist yet, measured on
    /// Cancun gas rules, test/HTLCPoseidonV2.test.js); the rest is margin for a gas repricing.
    /// Re-measure after any fork that changes storage or account-creation costs.
    uint256 public constant MIN_CLAIM_GAS = 540_000;
    /// What a caller should put in the transaction's gas limit: MIN_CLAIM_GAS plus the intrinsic cost,
    /// the calldata, the cold reads of the lock and the reentrancy flag (about 34,000), plus a margin.
    uint256 public constant RECOMMENDED_CLAIM_GAS_LIMIT = 650_000;

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
    error BadCalldataLength();
    error InsufficientGas();

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

    /**
     * @notice Lock msg.value for `receiver` under `lockAddr` until `timelock`.
     * @param lockAddr Parano1d address Addr(s) of the 32-byte secret (see contract docs).
     * @param timelock Absolute Unix timestamp; must be strictly in the future.
     * @param receiver Fixed payee on claim.
     * @return lockId  Identifier of the new lock.
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
     * @notice Reveal the secret and pay the receiver. Callable by anyone; funds always go to the
     *         lock's fixed receiver. Costs one Poseidon2b permutation of gas: send it with a gas
     *         limit of at least RECOMMENDED_CLAIM_GAS_LIMIT.
     */
    function claim(bytes32 lockId, bytes32 preimage) external nonReentrant {
        // selector (4) + lockId (32) + preimage (32): the secret is exactly 32 bytes, no tail
        if (msg.data.length != 68) revert BadCalldataLength();

        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.claimed) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (block.timestamp >= l.timelock) revert TimelockExpired();
        if (gasleft() < MIN_CLAIM_GAS) revert InsufficientGas();
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
