// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST ONLY. Pushes ETH into a contract that has no receive function.
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
