// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Poseidon2b} from "../Poseidon2b.sol";

/// @dev Test-only wrapper exposing the Poseidon2b library and measuring its gas. Never deploy.
contract Poseidon2bHarness {
    event Addr(bytes32 a);

    function addr(bytes32 s) external pure returns (bytes32) {
        return Poseidon2b.addr(s);
    }

    function derive(bytes32 m, uint32 index) external pure returns (bytes32) {
        return Poseidon2b.derive(m, index);
    }

    function addrStock(bytes32 m) external pure returns (bytes32) {
        return Poseidon2b.addrStock(m);
    }

    function permute(uint256[4] memory st) external pure returns (uint256[4] memory) {
        return Poseidon2b.permute(st);
    }

    function gmul(uint256 x, uint256 y) external pure returns (uint256) {
        return Poseidon2b.gmulFlat(x, y);
    }

    function gsqr(uint256 x) external pure returns (uint256) {
        return Poseidon2b.gsqrFlat(x);
    }

    function towerToFlat(uint256 v) external pure returns (uint256) {
        return Poseidon2b._towerToFlat(v);
    }

    function flatToTower(uint256 v) external pure returns (uint256) {
        return Poseidon2b._flatToTower(v);
    }

    // ---- batched variants: one eth_call per batch keeps the test suite light on the RPC layer

    function addrMany(bytes32[] calldata s) external pure returns (bytes32[] memory out) {
        out = new bytes32[](s.length);
        for (uint256 i = 0; i < s.length; i++) out[i] = Poseidon2b.addr(s[i]);
    }

    function deriveMany(bytes32[] calldata m, uint32[] calldata index) external pure returns (bytes32[] memory out) {
        out = new bytes32[](m.length);
        for (uint256 i = 0; i < m.length; i++) out[i] = Poseidon2b.derive(m[i], index[i]);
    }

    /// @dev `st` holds 4 lanes per state, flattened; returns the same layout.
    function permuteMany(uint256[] calldata st) external pure returns (uint256[] memory out) {
        out = new uint256[](st.length);
        for (uint256 i = 0; i + 4 <= st.length; i += 4) {
            uint256[4] memory r = Poseidon2b.permute([st[i], st[i + 1], st[i + 2], st[i + 3]]);
            out[i] = r[0];
            out[i + 1] = r[1];
            out[i + 2] = r[2];
            out[i + 3] = r[3];
        }
    }

    function gmulMany(uint256[] calldata x, uint256[] calldata y) external pure returns (uint256[] memory out) {
        out = new uint256[](x.length);
        for (uint256 i = 0; i < x.length; i++) out[i] = Poseidon2b.gmulFlat(x[i], y[i]);
    }

    function gsqrMany(uint256[] calldata x) external pure returns (uint256[] memory out) {
        out = new uint256[](x.length);
        for (uint256 i = 0; i < x.length; i++) out[i] = Poseidon2b.gsqrFlat(x[i]);
    }

    /// @dev out[i] = towerToFlat(v[i]) for i < n, flatToTower(v[i]) for the rest (n = v.length / 2).
    function convMany(uint256[] calldata v) external pure returns (uint256[] memory out) {
        out = new uint256[](v.length);
        uint256 n = v.length / 2;
        for (uint256 i = 0; i < v.length; i++) {
            out[i] = i < n ? Poseidon2b._towerToFlat(v[i]) : Poseidon2b._flatToTower(v[i]);
        }
    }

    /// @dev Pure execution cost of addr() measured with gasleft() around the call.
    function addrGas(bytes32 s) external view returns (uint256 gasUsed, bytes32 a) {
        uint256 g0 = gasleft();
        a = Poseidon2b.addr(s);
        gasUsed = g0 - gasleft();
    }

    function addrStockGas(bytes32 m) external view returns (uint256 gasUsed, bytes32 a) {
        uint256 g0 = gasleft();
        a = Poseidon2b.addrStock(m);
        gasUsed = g0 - gasleft();
    }

    /// @dev Micro-benchmarks of the primitives (gasleft() deltas, include the internal call).
    function gmulGas(uint256 x, uint256 y) external view returns (uint256 gasUsed, uint256 r) {
        uint256 g0 = gasleft();
        r = Poseidon2b.gmulFlat(x, y);
        gasUsed = g0 - gasleft();
    }

    function gsqrGas(uint256 x) external view returns (uint256 gasUsed, uint256 r) {
        uint256 g0 = gasleft();
        r = Poseidon2b.gsqrFlat(x);
        gasUsed = g0 - gasleft();
    }

    function towerToFlatGas(uint256 v) external view returns (uint256 gasUsed, uint256 r) {
        uint256 g0 = gasleft();
        r = Poseidon2b._towerToFlat(v);
        gasUsed = g0 - gasleft();
    }

    /// @dev Same as addr() but as a transaction, so the receipt's gasUsed includes the
    ///      21,000 base cost and calldata, like a real claim would.
    function addrTx(bytes32 s) external returns (bytes32 a) {
        a = Poseidon2b.addr(s);
        emit Addr(a);
    }
}
