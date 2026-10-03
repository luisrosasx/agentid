// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title CertIssuer
 * @notice Emisor de atestaciones AGENT.CERT. Cada certificado requiere quórum
 *         3-de-5 del issuerSet (firmas válidas, sin repetición) y una vigencia
 *         máxima de 24 horas. Permite anclar un root de Merkle de capacidades.
 */
contract CertIssuer {
    uint256 public constant MAX_VALIDITY = 24 hours;
    uint256 public constant QUORUM = 3;
    uint256 public constant ISSUER_COUNT = 5;

    struct Attestation {
        uint8 certType;
        bytes32 capabilitiesHash;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    mapping(uint256 => Attestation) public attestations; // agentId => attestation
    mapping(uint256 => bytes32) public anchorRoots; // agentId => root
    mapping(uint256 => uint256) public anchorLeafCounts; // agentId => leafCount
    mapping(bytes32 => bool) private _usedDigests;

    address[] public issuerSet;
    mapping(address => bool) public isIssuer;

    event AttestationIssued(uint256 indexed agentId, uint8 certType, bytes32 capabilitiesHash, uint64 issuedAt, uint64 expiresAt);
    event RootAnchored(uint256 indexed agentId, bytes32 root, uint256 leafCount);

    error InvalidIssuerSignature();
    error DuplicateSignature();
    error InsufficientQuorum();
    error InvalidExpiry();
    error NotAnIssuer();

    constructor(address[ISSUER_COUNT] memory _issuers) {
        for (uint256 i = 0; i < ISSUER_COUNT; i++) {
            issuerSet.push(_issuers[i]);
            isIssuer[_issuers[i]] = true;
        }
    }

    // Digest de la estructura; el prefijo personal EIP-191 se aplica al recuperar
    // (los emisores firman con wallet.signMessage sobre este digest).
    function _digest(uint256 agentId, uint8 certType, bytes32 capabilitiesHash, uint64 expiresAt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(agentId, certType, capabilitiesHash, expiresAt));
    }

    function issueAttestation(
        uint256 agentId,
        uint8 certType,
        bytes32 capabilitiesHash,
        uint64 expiresAt,
        bytes[] calldata sigs
    ) external {
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_VALIDITY) revert InvalidExpiry();

        uint64 issuedAt = uint64(block.timestamp);
        bytes32 digest = _digest(agentId, certType, capabilitiesHash, expiresAt);
        bytes32 msgHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));

        address[3] memory recovered;
        uint256 count = 0;
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = ecrecover(msgHash, uint8(sigs[i][64]), bytes32(sigs[i][0:32]), bytes32(sigs[i][32:64]));
            if (!isIssuer[signer]) revert InvalidIssuerSignature();
            bool dup = false;
            for (uint256 j = 0; j < count; j++) {
                if (recovered[j] == signer) dup = true;
            }
            if (dup) revert DuplicateSignature();
            recovered[count] = signer;
            count++;
        }
        if (count < QUORUM) revert InsufficientQuorum();

        if (_usedDigests[digest]) revert InvalidExpiry();
        _usedDigests[digest] = true;

        attestations[agentId] = Attestation({
            certType: certType,
            capabilitiesHash: capabilitiesHash,
            issuedAt: issuedAt,
            expiresAt: expiresAt
        });

        emit AttestationIssued(agentId, certType, capabilitiesHash, issuedAt, expiresAt);
    }

    function isValid(uint256 agentId) external view returns (bool) {
        Attestation memory a = attestations[agentId];
        return a.expiresAt > block.timestamp && a.issuedAt > 0;
    }

    function anchorRoot(uint256 agentId, bytes32 root, uint256 leafCount) external {
        if (!isIssuer[msg.sender]) revert NotAnIssuer();
        anchorRoots[agentId] = root;
        anchorLeafCounts[agentId] = leafCount;
        emit RootAnchored(agentId, root, leafCount);
    }
}
