// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST ONLY. A plain transfer to this contract costs well over 21,000 gas (one fresh storage write per call),
/// like a transfer to a never-used address does on public Sepolia: a fixed 21,000 gas limit runs out of gas.
contract CostlyReceive {
    uint256 public calls;

    receive() external payable {
        calls += 1;
    }
}
