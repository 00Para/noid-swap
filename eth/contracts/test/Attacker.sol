// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHTLC {
    function claim(bytes32 lockId, bytes32 preimage) external;
    function refund(bytes32 lockId) external;
}

/// TEST ONLY. Tries to re-enter claim()/refund() from its receive hook and
/// records whether the re-entrant call failed (it swallows the revert so the
/// outer call can still succeed).
contract Attacker {
    IHTLC public htlc;
    bytes32 public lockId;
    bytes32 public preimage;
    bool public reenterRefund;
    bool public attempted;
    bool public reentrySucceeded;

    function arm(IHTLC _htlc, bytes32 _lockId, bytes32 _preimage, bool _refund) external {
        htlc = _htlc;
        lockId = _lockId;
        preimage = _preimage;
        reenterRefund = _refund;
    }

    function lock(address target, bytes32 hashlock, uint256 timelock, address receiver) external payable returns (bytes32 id) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(
            abi.encodeWithSignature("newLock(bytes32,uint256,address)", hashlock, timelock, receiver)
        );
        require(ok, "newLock failed");
        id = abi.decode(ret, (bytes32));
    }

    function doRefund(IHTLC _htlc, bytes32 id) external {
        _htlc.refund(id);
    }

    receive() external payable {
        attempted = true;
        if (reenterRefund) {
            try htlc.refund(lockId) { reentrySucceeded = true; } catch {}
        } else {
            try htlc.claim(lockId, preimage) { reentrySucceeded = true; } catch {}
        }
    }
}
