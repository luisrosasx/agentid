// SPDX-License-Identifier: Apache-2.0
// EP-19-S3 — Agregación de sub-pruebas UltraHonk en una transacción.
//
// Un lote grande se parte en sub-lotes (≤N recibos cada uno); cada sub-lote se
// prueba por separado contra su sub-raíz (misma VK, circuito dc_subbatch) y esta
// transacción verifica todas las sub-pruebas en lote. El caller también fija el
// total del lote para el evento de auditoría.
pragma solidity ^0.8.24;

interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

contract BatchVerifier {
    IHonkVerifier public immutable verifier;

    event BatchVerified(uint256 subProofs, uint256 batchSize, bool allOk);

    constructor(IHonkVerifier _verifier) {
        verifier = _verifier;
    }

    /// @notice Verifica N sub-pruebas UltraHonk en una sola llamada.
    /// @return allOk true solo si TODAS las sub-pruebas verifican.
    function verifyBatch(
        bytes[] calldata proofs,
        bytes32[][] calldata publicInputs,
        uint256 batchSize
    ) external returns (bool allOk) {
        require(proofs.length == publicInputs.length, "length mismatch");
        require(proofs.length > 0 && proofs.length <= 256, "too many sub-proofs");
        for (uint256 i = 0; i < proofs.length; i++) {
            if (!verifier.verify(proofs[i], publicInputs[i])) {
                emit BatchVerified(proofs.length, batchSize, false);
                return false;
            }
        }
        emit BatchVerified(proofs.length, batchSize, true);
        return true;
    }
}
