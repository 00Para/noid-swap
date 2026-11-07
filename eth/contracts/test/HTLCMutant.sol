// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// TEST ONLY. NOT A DEPLOYMENT CANDIDATE. A copy of HTLC.sol with one deliberately planted bug,
/// selected by the constructor argument. Used by test/fuzz.test.js (FUZZ_MUTANT=n) to check that
/// the fuzz campaign actually detects each class of bug.
///   1 claim also allowed at block.timestamp == timelock   (claim/refund windows overlap)
///   2 refund refused at block.timestamp == timelock       (gap between the windows)
///   3 refund callable by anyone (still pays the sender)   (missing sender check)
///   4 payment before effects and no re-entrancy guard     (classic re-entrancy)
///   5 lock id leaves out the timelock                     (id collision)
///   6 a claimed lock can be claimed again                 (double spend)
///   8 refund of an already claimed lock is not refused    (claimed and refunded)
contract HTLCMutant {
    struct Lock {
        address sender;
        address receiver;
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;
        bool claimed;
        bool refunded;
        bytes32 preimage;
    }

    uint8 public immutable bug;
    mapping(bytes32 => Lock) private _locks;

    event Locked(bytes32 indexed lockId, address indexed sender, address indexed receiver, uint256 amount, bytes32 hashlock, uint256 timelock);
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

    function computeLockId(address sender, address receiver, uint256 amount, bytes32 hashlock, uint256 timelock) public view returns (bytes32) {
        if (bug == 5) return keccak256(abi.encodePacked(sender, receiver, amount, hashlock));
        return keccak256(abi.encodePacked(sender, receiver, amount, hashlock, timelock));
    }

    function newLock(bytes32 hashlock, uint256 timelock, address payable receiver) external payable nonReentrant returns (bytes32 lockId) {
        if (msg.value == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (timelock <= block.timestamp) revert TimelockNotInFuture();
        lockId = computeLockId(msg.sender, receiver, msg.value, hashlock, timelock);
        if (_locks[lockId].sender != address(0)) revert LockAlreadyExists();
        _locks[lockId] = Lock(msg.sender, receiver, msg.value, hashlock, timelock, false, false, bytes32(0));
        emit Locked(lockId, msg.sender, receiver, msg.value, hashlock, timelock);
    }

    function claim(bytes32 lockId, bytes32 preimage) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.claimed && bug != 6) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (sha256(abi.encodePacked(preimage)) != l.hashlock) revert InvalidPreimage();
        if (bug == 1) {
            if (block.timestamp > l.timelock) revert TimelockExpired();
        } else if (block.timestamp >= l.timelock) revert TimelockExpired();

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
        l.preimage = preimage;
        emit Claimed(lockId, preimage);
        (bool ok, ) = payable(receiver).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function refund(bytes32 lockId) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (msg.sender != l.sender && bug != 3) revert NotSender();
        if (l.claimed && bug != 8) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (bug == 2) {
            if (block.timestamp <= l.timelock) revert TimelockNotExpired();
        } else if (block.timestamp < l.timelock) revert TimelockNotExpired();
        uint256 amount = l.amount;
        address sender = l.sender;
        if (bug == 4) {
            (bool ok0, ) = payable(sender).call{value: amount}("");
            if (!ok0) revert TransferFailed();
            l.refunded = true;
            emit Refunded(lockId);
            return;
        }
        l.refunded = true;
        emit Refunded(lockId);
        (bool ok, ) = payable(sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        Lock memory l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        return l;
    }
}

/// TEST ONLY. HTLCERC20 with one planted bug. 1: no balance-delta check (fee-on-transfer tokens accepted);
/// 2: refund pays the receiver instead of the sender; 3: state written after the token transfer and no guard.
contract HTLCERC20Mutant {
    using SafeERC20 for IERC20;

    struct Lock {
        address sender;
        address receiver;
        IERC20 token;
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;
        bool claimed;
        bool refunded;
        bytes32 preimage;
    }

    uint8 public immutable bug;
    mapping(bytes32 => Lock) private _locks;

    event Locked(bytes32 indexed lockId, address indexed sender, address indexed receiver, address token, uint256 amount, bytes32 hashlock, uint256 timelock);
    event Claimed(bytes32 indexed lockId, bytes32 preimage);
    event Refunded(bytes32 indexed lockId);

    error ZeroAmount();
    error ZeroReceiver();
    error InvalidReceiver();
    error ZeroToken();
    error TimelockNotInFuture();
    error LockAlreadyExists();
    error LockNotFound();
    error InvalidPreimage();
    error TimelockExpired();
    error TimelockNotExpired();
    error AlreadyClaimed();
    error AlreadyRefunded();
    error NotSender();
    error UnsupportedToken();
    error Reentrancy();

    uint256 private _status = 1;

    constructor(uint8 _bug) {
        bug = _bug;
    }

    modifier nonReentrant() {
        if (bug != 3) {
            if (_status == 2) revert Reentrancy();
            _status = 2;
        }
        _;
        if (bug != 3) _status = 1;
    }

    function computeLockId(address sender, address receiver, address token, uint256 amount, bytes32 hashlock, uint256 timelock) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(sender, receiver, token, amount, hashlock, timelock));
    }

    function newLock(bytes32 hashlock, uint256 timelock, address receiver, IERC20 token, uint256 amount) external nonReentrant returns (bytes32 lockId) {
        if (amount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (receiver == address(this)) revert InvalidReceiver();
        if (address(token) == address(0)) revert ZeroToken();
        if (timelock <= block.timestamp) revert TimelockNotInFuture();
        lockId = computeLockId(msg.sender, receiver, address(token), amount, hashlock, timelock);
        if (_locks[lockId].sender != address(0)) revert LockAlreadyExists();
        _locks[lockId] = Lock(msg.sender, receiver, token, amount, hashlock, timelock, false, false, bytes32(0));
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (bug != 1 && token.balanceOf(address(this)) - before != amount) revert UnsupportedToken();
        emit Locked(lockId, msg.sender, receiver, address(token), amount, hashlock, timelock);
    }

    function claim(bytes32 lockId, bytes32 preimage) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.claimed) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (sha256(abi.encodePacked(preimage)) != l.hashlock) revert InvalidPreimage();
        if (block.timestamp >= l.timelock) revert TimelockExpired();
        if (bug == 3) {
            l.token.safeTransfer(l.receiver, l.amount);
            l.claimed = true;
            l.preimage = preimage;
            emit Claimed(lockId, preimage);
            return;
        }
        l.claimed = true;
        l.preimage = preimage;
        emit Claimed(lockId, preimage);
        l.token.safeTransfer(l.receiver, l.amount);
    }

    function refund(bytes32 lockId) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (msg.sender != l.sender) revert NotSender();
        if (l.claimed) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (block.timestamp < l.timelock) revert TimelockNotExpired();
        if (bug == 3) {
            l.token.safeTransfer(l.sender, l.amount);
            l.refunded = true;
            emit Refunded(lockId);
            return;
        }
        l.refunded = true;
        emit Refunded(lockId);
        l.token.safeTransfer(bug == 2 ? l.receiver : l.sender, l.amount);
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        Lock memory l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        return l;
    }
}
