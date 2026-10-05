// SPDX-License-Identifier: Apache-2.0
// EP-25 — Fase 10A: InterchangeSettlement on-chain.
//
// Registro y verificación (NO maneja ETH) del split de interchange que calcula
// off-chain apps/pob-api/src/settlement.ts. El operador fija la Merkle root del
// día (batchRootForDay, pares ordenados estilo OpenZeppelin) y cualquier gateway
// reclama su parte presentando proof + Settlement; el contrato re-deriva los
// montos con la MISMA tabla (GATEWAY_BPS_BY_TIER y retención por volumen) y
// revierte si no coinciden. La retención AGENT.ID se acredita como crédito de
// libro (agentidCredit), pendiente del token de crédito (EP-23).
//
// Upgradeable UUPS. Las funciones de configuración usan un patrón two-step con
// delay de 48h (pending + executableAfter), no un TimelockController completo.
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract InterchangeSettlement is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // ── Tipos ────────────────────────────────────────────────────────────────

    /// @dev Campos de SettlementRecord (pob-api). `day` (YYYY-MM-DD) se incluye
    /// porque el leaf lo serializa: keccak(JSON.stringify([gatewayId, day,
    /// volumeWei, gatewayAmountWei, agentidAmountWei])).
    struct Settlement {
        string gatewayId;
        string day;
        uint8 tier;
        uint256 volumeWei;
        uint16 gatewayBps;
        uint16 agentidBps;
        uint256 gatewayAmountWei;
        uint256 agentidAmountWei;
    }

    struct DaySettlement {
        bytes32 batchRoot;
        uint256 totalVolumeWei;
        uint256 gatewayCount;
        uint64 settledAt;
    }

    struct PendingAddress {
        address value;
        uint64 executableAfter;
    }

    struct PendingUint {
        uint16 value;
        uint64 executableAfter;
    }

    // ── Constantes de la tabla del blueprint (doc 05 §4) ─────────────────────

    /// @dev GATEWAY_BPS_BY_TIER (tier 1 = mayor volumen): 60 → 25.
    function _gatewayBpsForTier(uint8 tier) private pure returns (uint16) {
        if (tier == 1) return 60;
        if (tier == 2) return 50;
        if (tier == 3) return 40;
        if (tier == 4) return 32;
        return 25; // tier == 5
    }

    uint16 public constant MIN_GATEWAY_BPS = 25;
    uint16 public constant MAX_GATEWAY_BPS = 60;

    /// @dev Delay del two-step de configuración.
    uint64 public constant CONFIG_DELAY = 48 hours;

    // ── Estado ───────────────────────────────────────────────────────────────

    mapping(uint256 => DaySettlement) public dailySettlements;
    mapping(uint256 => mapping(bytes32 => bool)) public claimed;
    mapping(uint256 => uint256) public agentidCredit;
    mapping(address => bool) public operators;

    address public treasury;
    uint16 public minAgentidBps;
    uint16 public maxAgentidBps;

    PendingAddress public pendingTreasury;
    PendingUint public pendingMinAgentidBps;
    PendingUint public pendingMaxAgentidBps;

    // ── Eventos ──────────────────────────────────────────────────────────────

    event DaySettled(uint256 indexed day, bytes32 batchRoot, uint256 totalVolumeWei, uint256 gatewayCount);
    event SettlementClaimed(uint256 indexed day, bytes32 leafHash, string gatewayId, address payee, uint256 gatewayAmountWei, uint256 agentidAmountWei);
    event TreasuryChangeScheduled(address newTreasury, uint64 executableAfter);
    event TreasuryChanged(address newTreasury);
    event AgentidBpsChangeScheduled(uint16 newMin, uint16 newMax, uint64 executableAfter);
    event AgentidBpsChanged(uint16 newMin, uint16 newMax);
    event OperatorSet(address operator, bool allowed);

    // ── Errores ──────────────────────────────────────────────────────────────

    error NotOperator();
    error DayAlreadySettled(uint256 day);
    error DayNotSettled(uint256 day);
    error InvalidTier(uint8 tier);
    error GatewayBpsOutOfRange(uint16 bps);
    error AgentidBpsOutOfRange(uint16 bps);
    error AmountMismatch();
    error InvalidProof();
    error AlreadyClaimed(bytes32 leafHash);
    error InvalidGatewayId();
    error InvalidDayString();
    error NoPendingChange();
    error ChangeNotExecutable(uint64 executableAfter);
    error InvalidBpsRange();
    error InvalidTreasury();

    // ── Init / upgrade ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address treasury_) external initializer {
        __Ownable_init(owner_);
        if (treasury_ == address(0)) revert InvalidTreasury();
        treasury = treasury_;
        minAgentidBps = 50;
        maxAgentidBps = 90;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ── Configuración two-step con delay 48h ─────────────────────────────────

    function scheduleTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidTreasury();
        pendingTreasury = PendingAddress({value: newTreasury, executableAfter: uint64(block.timestamp) + CONFIG_DELAY});
        emit TreasuryChangeScheduled(newTreasury, pendingTreasury.executableAfter);
    }

    function applyTreasury() external {
        PendingAddress memory p = pendingTreasury;
        if (p.value == address(0)) revert NoPendingChange();
        if (block.timestamp < p.executableAfter) revert ChangeNotExecutable(p.executableAfter);
        treasury = p.value;
        delete pendingTreasury;
        emit TreasuryChanged(p.value);
    }

    function scheduleAgentidBps(uint16 newMin, uint16 newMax) external onlyOwner {
        if (newMin < 50 || newMax > 90 || newMin > newMax) revert InvalidBpsRange();
        pendingMinAgentidBps = PendingUint({value: newMin, executableAfter: uint64(block.timestamp) + CONFIG_DELAY});
        pendingMaxAgentidBps = PendingUint({value: newMax, executableAfter: uint64(block.timestamp) + CONFIG_DELAY});
        emit AgentidBpsChangeScheduled(newMin, newMax, pendingMinAgentidBps.executableAfter);
    }

    function applyAgentidBps() external {
        PendingUint memory lo = pendingMinAgentidBps;
        PendingUint memory hi = pendingMaxAgentidBps;
        if (lo.executableAfter == 0 || hi.executableAfter == 0) revert NoPendingChange();
        if (block.timestamp < lo.executableAfter || block.timestamp < hi.executableAfter) {
            revert ChangeNotExecutable(lo.executableAfter);
        }
        minAgentidBps = lo.value;
        maxAgentidBps = hi.value;
        delete pendingMinAgentidBps;
        delete pendingMaxAgentidBps;
        emit AgentidBpsChanged(lo.value, hi.value);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner() && !operators[msg.sender]) revert NotOperator();
        _;
    }

    // ── Settlement diario ────────────────────────────────────────────────────

    function settleDay(
        uint256 day,
        bytes32 batchRoot,
        uint256 totalVolumeWei,
        uint256 gatewayCount
    ) external onlyOwnerOrOperator {
        if (dailySettlements[day].batchRoot != bytes32(0)) revert DayAlreadySettled(day);
        dailySettlements[day] = DaySettlement({
            batchRoot: batchRoot,
            totalVolumeWei: totalVolumeWei,
            gatewayCount: gatewayCount,
            settledAt: uint64(block.timestamp)
        });
        emit DaySettled(day, batchRoot, totalVolumeWei, gatewayCount);
    }

    function getDaySettlement(uint256 day) external view returns (DaySettlement memory) {
        return dailySettlements[day];
    }

    // ── Split determinístico (port literal de settlement.ts) ─────────────────

    function agentidBpsForVolume(uint256 volumeWei) public view returns (uint16) {
        // Umbrales idénticos a AGENTID_VOLUME_STEPS (créditos de 18 decimales):
        // 100k→90, 1M→80, 10M→70, 100M→60, >100M→50. Comparación `<=`.
        if (volumeWei <= 100_000 * 10 ** 18) return 90;
        if (volumeWei <= 1_000_000 * 10 ** 18) return 80;
        if (volumeWei <= 10_000_000 * 10 ** 18) return 70;
        if (volumeWei <= 100_000_000 * 10 ** 18) return 60;
        return 50;
    }

    function deriveSplit(uint8 tier, uint256 volumeWei)
        public
        view
        returns (uint16 gatewayBps, uint16 agentidBps, uint256 gatewayAmountWei, uint256 agentidAmountWei)
    {
        if (tier == 0 || tier > 5) revert InvalidTier(tier);
        gatewayBps = _gatewayBpsForTier(tier);
        agentidBps = agentidBpsForVolume(volumeWei);
        if (gatewayBps < MIN_GATEWAY_BPS || gatewayBps > MAX_GATEWAY_BPS) revert GatewayBpsOutOfRange(gatewayBps);
        if (agentidBps < minAgentidBps || agentidBps > maxAgentidBps) revert AgentidBpsOutOfRange(agentidBps);
        gatewayAmountWei = (volumeWei * gatewayBps) / 10_000;
        agentidAmountWei = (volumeWei * agentidBps) / 10_000;
    }

    // ── Claim ────────────────────────────────────────────────────────────────

    function claim(uint256 day, Settlement calldata s, bytes32[] calldata proof, address payee) external {
        DaySettlement memory ds = dailySettlements[day];
        if (ds.batchRoot == bytes32(0)) revert DayNotSettled(day);

        (uint16 gatewayBps, uint16 agentidBps, uint256 gatewayAmountWei, uint256 agentidAmountWei) = deriveSplit(s.tier, s.volumeWei);
        if (s.gatewayBps != gatewayBps || s.agentidBps != agentidBps) revert AmountMismatch();
        if (s.gatewayAmountWei != gatewayAmountWei || s.agentidAmountWei != agentidAmountWei) {
            revert AmountMismatch();
        }

        bytes32 leaf = settlementLeaf(s);
        bytes32 leafHash = keccak256(bytes.concat(leaf));
        if (claimed[day][leafHash]) revert AlreadyClaimed(leafHash);
        if (!MerkleProof.verify(proof, ds.batchRoot, leaf)) revert InvalidProof();

        claimed[day][leafHash] = true;
        agentidCredit[day] += agentidAmountWei;
        emit SettlementClaimed(day, leafHash, s.gatewayId, payee, gatewayAmountWei, agentidAmountWei);
    }

    function isClaimed(uint256 day, bytes32 leafHash) external view returns (bool) {
        return claimed[day][leafHash];
    }

    /// @dev Réplica en Solidity del leaf de pob-api/src/settlement.ts:
    /// keccak256(toUtf8Bytes(JSON.stringify([gatewayId, day, volumeWei,
    /// gatewayAmountWei, agentidAmountWei]))). JSON.stringify de un array de
    /// strings produce exactamente `["a","b","c","d","e"]` sin espacios. Para
    /// que la serialización coincida, gatewayId y day no pueden contener `"` ni
    /// `\` (en JSON esos caracteres se escapan; aquí se rechazan).
    function settlementLeaf(Settlement calldata s) public pure returns (bytes32) {
        _validateJsonString(s.gatewayId);
        _validateDayString(s.day);
        bytes memory payload = abi.encodePacked(
            '["', s.gatewayId, '","', s.day, '","',
            Strings.toString(s.volumeWei), '","',
            Strings.toString(s.gatewayAmountWei), '","',
            Strings.toString(s.agentidAmountWei), '"]'
        );
        return keccak256(payload);
    }

    function _validateJsonString(string calldata value) private pure {
        bytes memory b = bytes(value);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == '"' || b[i] == "\\" || uint8(b[i]) < 0x20) revert InvalidGatewayId();
        }
    }

    function _validateDayString(string calldata day) private pure {
        bytes memory b = bytes(day);
        if (b.length != 10) revert InvalidDayString();
        for (uint256 i = 0; i < 10; i++) {
            if (i == 4 || i == 7) {
                if (b[i] != "-") revert InvalidDayString();
            } else if (b[i] < 0x30 || b[i] > 0x39) {
                revert InvalidDayString();
            }
        }
    }
}
