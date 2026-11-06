// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title HTLC
 * @notice SHA-256 hash-time-locked contract for native ETH. Ethereum half of a
 *         NOID <-> ETH atomic swap.
 *
 * PREIMAGE ENCODING (the counterparty chain MUST match this exactly)
 * ------------------------------------------------------------------
 *   - The secret ("preimage") is exactly 32 raw bytes (a bytes32).
 *   - hashlock = SHA-256(preimage), computed over those 32 raw bytes ONLY:
 *     no length prefix, no padding, no hex/ASCII text encoding, no domain tag.
 *     In Solidity: sha256(abi.encodePacked(preimage)), which for a bytes32 is
 *     the same as sha256(abi.encodePacked(bytes32)) over exactly 32 bytes.
 *   - NOTE this is SHA-256, NOT keccak256. Ethereum's native hash is keccak256;
 *     SHA-256 is the 0x02 precompile.
 *   - Byte order is the natural one: byte 0 of the secret is the first byte
 *     fed into SHA-256, and the 32-byte digest is stored as a bytes32 with the
 *     digest's first byte as the most significant byte (i.e. the usual hex
 *     string of the digest, as printed by `sha256sum` / Node crypto).
 *
 * TIMELOCK RULES
 * --------------
 *   - `timelock` is an absolute Unix timestamp in seconds (block.timestamp).
 *   - claim()  is allowed only while  block.timestamp <  timelock.
 *   - refund() is allowed only when   block.timestamp >= timelock.
 *   The two windows are disjoint and exhaustive, so a lock can never be both
 *   claimable and refundable in the same block.
 *
 * LOCK ID
 * -------
 *   lockId = keccak256(abi.encodePacked(sender, receiver, amount, hashlock, timelock))
 *   It is deterministic (no nonce), so the counterparty can compute it
 *   off-chain, and an identical lock (same sender, receiver, amount, hashlock,
 *   timelock) cannot be created twice: the second newLock reverts with
 *   LockAlreadyExists. Vary the timelock (or amount) to create a distinct lock.
 *
 * HAZARD: a receiver that cannot accept ETH
 * -----------------------------------------
 *   Funds are always paid to the fixed `receiver` with a low-level call. If
 *   the receiver is a contract that reverts on receiving ETH (no payable
 *   receive/fallback, or one that reverts), claim() reverts and the funds stay
 *   locked. They are NOT lost: once the timelock expires the sender can
 *   refund(). But the swap cannot complete on that lock, and the receiver is
 *   unable to claim before the timeout. Choose an EOA or a contract known to
 *   accept ETH as the receiver. (An unrelated third party can call claim()
 *   with the preimage, but it always pays the fixed receiver, so that does
 *   not help.)
 *
 * PREIMAGE IS PUBLIC
 * ------------------
 *   claim() takes the preimage as calldata and stores it in the lock and in
 *   the Claimed event. Anyone, including a mempool watcher, can read it. That
 *   is the point (the counterparty needs it), but note anyone who sees the
 *   preimage in the mempool before the claim is mined could also call claim()
 *   themselves: harmless here because funds still go to `receiver`.
 */
contract HTLC {
    struct Lock {
        address sender;
        address receiver;
        uint256 amount;
        bytes32 hashlock;
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
        bytes32 hashlock,
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
        bytes32 hashlock,
        uint256 timelock
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(sender, receiver, amount, hashlock, timelock));
    }

    /**
     * @notice Lock msg.value for `receiver` under `hashlock` until `timelock`.
     * @param hashlock SHA-256 of the 32-byte preimage (see contract docs).
     * @param timelock Absolute Unix timestamp; must be strictly in the future.
     * @param receiver Fixed payee on claim.
     * @return lockId  Identifier of the new lock.
     */
    function newLock(
        bytes32 hashlock,
        uint256 timelock,
        address payable receiver
    ) external payable nonReentrant returns (bytes32 lockId) {
        if (msg.value == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (timelock <= block.timestamp) revert TimelockNotInFuture();

        lockId = computeLockId(msg.sender, receiver, msg.value, hashlock, timelock);
        if (_locks[lockId].sender != address(0)) revert LockAlreadyExists();

        _locks[lockId] = Lock({
            sender: msg.sender,
            receiver: receiver,
            amount: msg.value,
            hashlock: hashlock,
            timelock: timelock,
            claimed: false,
            refunded: false,
            preimage: bytes32(0)
        });

        emit Locked(lockId, msg.sender, receiver, msg.value, hashlock, timelock);
    }

    /**
     * @notice Reveal the preimage and pay the receiver. Callable by anyone;
     *         funds always go to the lock's fixed receiver.
     */
    function claim(bytes32 lockId, bytes32 preimage) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.claimed) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (sha256(abi.encodePacked(preimage)) != l.hashlock) revert InvalidPreimage();
        if (block.timestamp >= l.timelock) revert TimelockExpired();

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
