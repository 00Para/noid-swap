// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title HTLCERC20
 * @notice SHA-256 HTLC for ERC20 tokens. Same semantics, preimage encoding and
 *         timelock rules as {HTLC} (see that contract for the full notes):
 *           - preimage = 32 raw bytes; hashlock = sha256(preimage), no prefix
 *           - claim()  only while block.timestamp <  timelock
 *           - refund() only when  block.timestamp >= timelock, by sender only
 *
 *         The sender must approve this contract for `amount` of `token`
 *         before calling newLock.
 *
 *         Fee-on-transfer / rebasing tokens are rejected: newLock reverts
 *         unless the contract's balance grows by exactly `amount`.
 *
 *         Hazard: if the token blocks transfers to `receiver` (e.g. a
 *         blacklist), claim() reverts and funds stay locked until the sender
 *         refunds after the timelock.
 */
contract HTLCERC20 {
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

    mapping(bytes32 => Lock) private _locks;

    event Locked(
        bytes32 indexed lockId,
        address indexed sender,
        address indexed receiver,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );
    event Claimed(bytes32 indexed lockId, bytes32 preimage);
    event Refunded(bytes32 indexed lockId);

    error ZeroAmount();
    error ZeroReceiver();
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

    modifier nonReentrant() {
        if (_status == 2) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }

    function computeLockId(
        address sender,
        address receiver,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(sender, receiver, token, amount, hashlock, timelock));
    }

    function newLock(
        bytes32 hashlock,
        uint256 timelock,
        address receiver,
        IERC20 token,
        uint256 amount
    ) external nonReentrant returns (bytes32 lockId) {
        if (amount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (address(token) == address(0)) revert ZeroToken();
        if (timelock <= block.timestamp) revert TimelockNotInFuture();

        lockId = computeLockId(msg.sender, receiver, address(token), amount, hashlock, timelock);
        if (_locks[lockId].sender != address(0)) revert LockAlreadyExists();

        _locks[lockId] = Lock({
            sender: msg.sender,
            receiver: receiver,
            token: token,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            claimed: false,
            refunded: false,
            preimage: bytes32(0)
        });

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert UnsupportedToken();

        emit Locked(lockId, msg.sender, receiver, address(token), amount, hashlock, timelock);
    }

    function claim(bytes32 lockId, bytes32 preimage) external nonReentrant {
        Lock storage l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.claimed) revert AlreadyClaimed();
        if (l.refunded) revert AlreadyRefunded();
        if (sha256(abi.encodePacked(preimage)) != l.hashlock) revert InvalidPreimage();
        if (block.timestamp >= l.timelock) revert TimelockExpired();

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

        l.refunded = true;

        emit Refunded(lockId);

        l.token.safeTransfer(l.sender, l.amount);
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        Lock memory l = _locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        return l;
    }
}
