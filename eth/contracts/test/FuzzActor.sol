// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST ONLY. A contract account that can play any role in the fuzz campaign
/// (sender, receiver, third-party caller). `exec` forwards an arbitrary call
/// from this contract and bubbles the revert data up unchanged. The behaviour
/// of its `receive()` is selected by `mode`:
///   0 ACCEPT       takes the ETH
///   1 REJECT       reverts (a receiver that cannot accept ETH)
///   2 REENTER      accepts, but first tries to re-enter claim / refund / newLock
///                  on `htlc` for every stored (lockId, preimage) pair
///   3 BURN_GAS     consumes all forwarded gas (invalid opcode)
///   4 RETURN_BOMB  returns `bombSize` bytes of return data
contract FuzzActor {
    uint8 public mode;
    uint256 public bombSize;
    address public htlc;
    bool public erc20Layout; // getLock layout of HTLCERC20 (token field present)

    bytes32[] public ids;
    bytes32[] public preimages;

    // re-entrancy bookkeeping
    uint256 public hookRuns;
    uint256 public attempts;
    uint256 public successes;
    bool public hookSawClaimed;
    bool public hookSawRefunded;
    uint256 public hookSawBalance;

    function fund() external payable {}

    function setMode(uint8 m) external {
        mode = m;
    }

    function setBombSize(uint256 n) external {
        bombSize = n;
    }

    function arm(address _htlc, bool _erc20Layout) external {
        htlc = _htlc;
        erc20Layout = _erc20Layout;
        delete ids;
        delete preimages;
    }

    function addTarget(bytes32 id, bytes32 pre) external {
        ids.push(id);
        preimages.push(pre);
    }

    function exec(address target, uint256 value, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {
        uint8 m = mode;
        if (m == 1) revert("FuzzActor: rejecting ETH");
        if (m == 3) {
            assembly {
                invalid()
            }
        }
        if (m == 4) {
            uint256 n = bombSize;
            assembly {
                return(0, n)
            }
        }
        if (m == 2) _reenter();
    }

    function _reenter() internal {
        hookRuns++;
        for (uint256 i = 0; i < ids.length; i++) {
            bytes32 id = ids[i];
            // read-only view of the lock while the outer call is mid-flight
            (bool okv, bytes memory lk) = htlc.staticcall(abi.encodeWithSignature("getLock(bytes32)", id));
            if (okv && lk.length >= 256) {
                uint256 ci = erc20Layout ? 6 : 5;
                bool c;
                bool r;
                assembly {
                    c := mload(add(lk, add(32, mul(ci, 32))))
                    r := mload(add(lk, add(32, mul(add(ci, 1), 32))))
                }
                hookSawClaimed = c;
                hookSawRefunded = r;
            }
            hookSawBalance = htlc.balance;

            attempts++;
            (bool a, ) = htlc.call(abi.encodeWithSignature("claim(bytes32,bytes32)", id, preimages[i]));
            if (a) successes++;
            attempts++;
            (bool b, ) = htlc.call(abi.encodeWithSignature("refund(bytes32)", id));
            if (b) successes++;
            if (!erc20Layout && address(this).balance >= 1) {
                attempts++;
                (bool c2, ) = htlc.call{value: 1}(
                    abi.encodeWithSignature(
                        "newLock(bytes32,uint256,address)",
                        sha256(abi.encodePacked(id)),
                        block.timestamp + 1000,
                        address(this)
                    )
                );
                if (c2) successes++;
            }
        }
    }
}
