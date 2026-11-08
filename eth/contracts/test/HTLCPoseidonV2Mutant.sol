// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Poseidon2b} from "../Poseidon2b.sol";

/// TEST ONLY. NOT A DEPLOYMENT CANDIDATE. A copy of HTLCPoseidonV2.sol with one deliberately planted bug,
/// selected by the constructor argument. Used by test/fuzz.test.js (FUZZ_MUTANT_P=n) to check that the
/// fuzz campaign against HTLCPoseidonV2 actually detects each class of bug.
///   1 claim also allowed at block.timestamp == timelock    (claim/refund windows overlap)
///   2 refund refused at block.timestamp == timelock        (gap between the windows)
///   3 refund callable by anyone (still pays the sender)    (missing sender check)
///   4 payment before effects and no re-entrancy guard      (classic re-entrancy)
///   5 lock id leaves out the timelock                      (id collision)
///   6 a claimed lock can be claimed again                  (double spend)
///   7 claim does not check the timelock at all             (claim after expiry)
///   8 trailing calldata bytes after the secret are accepted (secret not exactly 32 bytes)
///   9 the secret is hashed with SHA-256 instead of Addr    (wrong lock function)
///  10 the stored preimage is not the revealed one          (storage disagrees with the event)
contract HTLCPoseidonV2Mutant {
    struct Lock {
        address sender;
        address receiver;
        uint256 amount;
        bytes32 lockAddr;
        uint256 timelock;
        bool claimed;
        bool refunded;
        bytes32 preimage;
    }

    uint8 public immutable bug;
    uint256 public constant MIN_CLAIM_GAS = 540_000;
    mapping(bytes32 => Lock) private _locks;

    event Locked(bytes32 indexed lockId, address indexed sender, address indexed receiver, uint256 amount, bytes32 lockAddr, uint256 timelock);
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

    uint256 private _status = 1;

    constructor(uint8 _bug) {
        bug = _bug;
    }

    modifier nonReentrant() {
        if (bug != 4) {
            if (_status == 2) revert Reentrancy();
            _status = 2;
        }
        _;
        if (bug != 4) _status = 1;
    }

    function computeLockId(address sender, address receiver, uint256 amount, bytes32 lockAddr, uint256 timelock) public view returns (bytes32) {
        if (bug == 5) return keccak256(abi.encodePacked(sender, receiver, amount, lockAddr));
        return keccak256(abi.encodePacked(sender, receiver, amount, lockAddr, timelock));
    }

    function newLock(bytes32 lockAddr, uint256 timelock, address payable receiver) external payable nonReentrant returns (bytes32 lockId) {
        if (msg.value == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (timelock <= block.timestamp) revert TimelockNotInFuture();
        lockId = computeLockId(msg.sender, receiver, msg.value, lockAddr, timelock);
        if (_locks[lockId].sender != address(0)) revert LockAlreadyExists();
        _locks[lockId] = Lock(msg.sender, receiver, msg.value, lockAddr, timelock, false, false, bytes32(0));
        emit Locked(lockId, msg.sender, receiver, msg.value, lockAddr, timelock);
    }

    function claim(bytes32 lockId, bytes32 preimage) external nonReentrant {
        if (bug != 8 && msg.data.length != 68) revert BadCalldataLength();
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.claimed && bug != 6) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (bug == 1) {
            if (block.timestamp > l.timelock) revert TimelockExpired();
        } else if (bug != 7) {
            if (block.timestamp >= l.timelock) revert TimelockExpired();
        }
        if (gasleft() < MIN_CLAIM_GAS) revert InsufficientGas();
        bytes32 a;
        if (bug == 9) a = sha256(abi.encodePacked(preimage));
        else a = Poseidon2b.addr(preimage);
        if (a != l.lockAddr) revert InvalidPreimage();

        uint256 amount = l.amount;
        address receiver = l.receiver;
        if (bug == 4) {
            (bool ok0, ) = payable(receiver).call{value: amount}("");
            if (!ok0) revert TransferFailed();
            l.claimed = true;
            l.preimage = preimage;
            emit Claimed(lockId, preimage);
            return;
        }
        l.claimed = true;
        l.preimage = bug == 10 ? preimage ^ bytes32(uint256(1)) : preimage;
        emit Claimed(lockId, preimage);
        (bool ok, ) = payable(receiver).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function refund(bytes32 lockId) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (bug != 3 && msg.sender != l.sender) revert NotSender();
        if (l.claimed) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (bug == 2) {
            if (block.timestamp <= l.timelock) revert TimelockNotExpired();
        } else if (block.timestamp < l.timelock) {
            revert TimelockNotExpired();
        }
        l.refunded = true;
        uint256 amount = l.amount;
        emit Refunded(lockId);
        (bool ok, ) = payable(l.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        Lock memory l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        return l;
    }
}
