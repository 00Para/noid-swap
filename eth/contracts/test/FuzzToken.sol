// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// TEST ONLY. An ERC-20 whose misbehaviour is selected at run time.
///   0 NORMAL
///   1 FEE_IN          transferFrom delivers 99% (1% burned); fee = value/100
///   2 FEE_OUT         transfer delivers 99%
///   3 FEE_ON_TOP_OUT  transfer delivers `value` but burns a further 1% from the sender
///   4 REVERT_OUT      transfer reverts
///   5 REVERT_IN       transferFrom reverts
///   6 FALSE_OUT       transfer returns false, moves nothing
///   7 FALSE_IN        transferFrom returns false, moves nothing
///   8 LIE_IN          transferFrom returns true, moves nothing
///   9 LIE_OUT         transfer returns true, moves nothing
///  10 REENTER         transfer / transferFrom first try to re-enter `htlc`, then behave normally
///  11 PAUSED          every transfer reverts
/// `blocked[a]` makes any transfer to `a` revert (a blacklist).
contract FuzzToken is ERC20 {
    uint8 public mode;
    address public htlc;
    mapping(address => bool) public blocked;
    bytes32[] public ids;
    bytes32[] public preimages;
    uint256 public attempts;
    uint256 public successes;

    constructor() ERC20("Fuzz", "FZZ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// simulate a negative rebase / confiscation
    function burnFrom(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function arm(address _htlc) external {
        htlc = _htlc;
        delete ids;
        delete preimages;
    }

    function addTarget(bytes32 id, bytes32 pre) external {
        ids.push(id);
        preimages.push(pre);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        uint8 m = mode;
        address from = msg.sender;
        if (m == 11 || blocked[to] || m == 4) revert("FuzzToken: transfer blocked");
        if (m == 6) return false;
        if (m == 9) return true;
        if (m == 10) _reenter();
        if (m == 2) {
            uint256 fee = value / 100;
            _transfer(from, to, value - fee);
            if (fee > 0) _burn(from, fee);
            return true;
        }
        if (m == 3) {
            _transfer(from, to, value);
            uint256 fee = value / 100;
            if (fee > 0) _burn(from, fee);
            return true;
        }
        _transfer(from, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        uint8 m = mode;
        if (m == 11 || blocked[to] || m == 5) revert("FuzzToken: transferFrom blocked");
        if (m == 7) return false;
        if (m == 8) return true;
        if (m == 10) _reenter();
        _spendAllowance(from, msg.sender, value);
        if (m == 1) {
            uint256 fee = value / 100;
            _transfer(from, to, value - fee);
            if (fee > 0) _burn(from, fee);
            return true;
        }
        _transfer(from, to, value);
        return true;
    }

    function _reenter() internal {
        for (uint256 i = 0; i < ids.length; i++) {
            attempts++;
            (bool a, ) = htlc.call(abi.encodeWithSignature("claim(bytes32,bytes32)", ids[i], preimages[i]));
            if (a) successes++;
            attempts++;
            (bool b, ) = htlc.call(abi.encodeWithSignature("refund(bytes32)", ids[i]));
            if (b) successes++;
            attempts++;
            (bool c, ) = htlc.call(
                abi.encodeWithSignature(
                    "newLock(bytes32,uint256,address,address,uint256)",
                    ids[i],
                    block.timestamp + 1000,
                    address(this),
                    address(this),
                    uint256(1)
                )
            );
            if (c) successes++;
        }
    }
}
