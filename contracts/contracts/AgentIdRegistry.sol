// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AgentIdRegistry
 * @notice Soulbound ERC-721 mínimo para identidades agénticas (CardCA).
 *         Los tokens no pueden transferirse. El mint es payable (stake >= 0.01 ETH,
 *         quemable por el owner del token) y solo lo ejecuta un operador autorizado
 *         como Registrar con firma KYC (EIP-712) del compliance signer.
 *         Cada operador (fleet) tiene una cuota máxima de agentes (fleetQuota).
 */
contract AgentIdRegistry {
    string public constant NAME = "CardCA Registry";
    string public constant VERSION = "1";
    uint256 public constant MIN_STAKE = 0.01 ether;
    uint256 public constant KYC_EXPIRY = 7 days;

    // ---- ERC-721 mínimo ----
    string public name = NAME;
    string public symbol = "AGID";
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;

    // ---- Registro ----
    address public immutable registrar;
    address public immutable complianceSigner;
    uint256 private _nextId = 1;

    struct Stake {
        uint256 amount;
        bool withdrawn;
    }
    mapping(uint256 => Stake) public stakes;

    // ---- Flota ----
    mapping(address => uint256) public fleetQuota; // operator => cap
    mapping(address => uint256) public fleetCount; // operator => count

    // ---- EIP-712 ----
    bytes32 private immutable _DOMAIN_SEPARATOR;
    bytes32 private constant KYC_TYPEHASH =
        keccak256("KYCAttestation(address owner,uint256 agentId,uint256 expiresAt)");

    event AgentMinted(address indexed operator, address indexed owner, uint256 indexed agentId, uint256 stake);
    event StakeBurned(address indexed to, uint256 indexed agentId, uint256 amount);
    event FleetQuotaSet(address indexed operator, uint256 cap);

    error SOULBOUND();
    error NotRegistrar();
    error InvalidKYCSignature();
    error KYCExpired();
    error InsufficientStake();
    error QuotaExceeded();
    error AlreadyMinted();
    error NotTokenOwner();
    error StakeAlreadyBurned();
    error ETHTransferFailed();

    constructor(address _registrar, address _complianceSigner) {
        require(_registrar != address(0) && _complianceSigner != address(0), "zero address");
        registrar = _registrar;
        complianceSigner = _complianceSigner;
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function ownerOf(uint256 agentId) public view returns (address) {
        address owner = _owners[agentId];
        if (owner == address(0)) revert("CARDCA: nonexistent token");
        return owner;
    }

    function balanceOf(address owner) public view returns (uint256) {
        return _balances[owner];
    }

    function setFleetQuota(address operator, uint256 cap) external {
        if (msg.sender != registrar) revert NotRegistrar();
        fleetQuota[operator] = cap;
        emit FleetQuotaSet(operator, cap);
    }

    /**
     * @notice Mint de una identidad agéntica. msg.sender es el operador de flota.
     * @param owner         Titular de la identidad (del lado del operador).
     * @param agentId       Id de agente ( tokenId). 0 = auto-asignado.
     * @param expiresAt     Vencimiento de la atestación KYC.
     * @param kycSig        Firma EIP-712 del compliance signer.
     */
    function mint(
        address owner,
        uint256 agentId,
        uint256 expiresAt,
        bytes calldata kycSig
    ) external payable returns (uint256) {
        if (msg.value < MIN_STAKE) revert InsufficientStake();

        if (fleetCount[msg.sender] >= fleetQuota[msg.sender]) revert QuotaExceeded();

        if (agentId == 0) {
            agentId = _nextId;
        }
        if (_owners[agentId] != address(0)) revert AlreadyMinted();

        if (expiresAt <= block.timestamp) revert KYCExpired();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, keccak256(abi.encode(KYC_TYPEHASH, owner, agentId, expiresAt)))
        );
        // El compliance signer firma el digest EIP-712 (32 bytes) con signMessage => prefijo personal EIP-191.
        bytes32 msgHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address recovered = ecrecover(msgHash, uint8(kycSig[64]), bytes32(kycSig[0:32]), bytes32(kycSig[32:64]));
        if (recovered == address(0) || recovered != complianceSigner) revert InvalidKYCSignature();

        _owners[agentId] = owner;
        _balances[owner] += 1;
        stakes[agentId] = Stake({ amount: msg.value, withdrawn: false });
        fleetCount[msg.sender] += 1;
        if (agentId >= _nextId) _nextId = agentId + 1;

        emit AgentMinted(msg.sender, owner, agentId, msg.value);
        return agentId;
    }

    /**
     * @notice Quema el stake de un agente: transfiere el ETH al owner del token y
     *         marca el stake como retirado. La identidad sigue siendo soulbound.
     */
    function burnStake(uint256 agentId) external {
        Stake storage s = stakes[agentId];
        if (ownerOf(agentId) != msg.sender) revert NotTokenOwner();
        if (s.withdrawn || s.amount == 0) revert StakeAlreadyBurned();
        s.withdrawn = true;
        uint256 amount = s.amount;
        s.amount = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert ETHTransferFailed();
        emit StakeBurned(msg.sender, agentId, amount);
    }

    // ---- Deshabilitación soulbound explícita ----
    function transferFrom(address, address, uint256) public pure {
        revert SOULBOUND();
    }

    function safeTransferFrom(address, address, uint256) public pure {
        revert SOULBOUND();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) public pure {
        revert SOULBOUND();
    }

    function approve(address, uint256) public pure {
        revert SOULBOUND();
    }

    function setApprovalForAll(address, bool) public pure {
        revert SOULBOUND();
    }
}
