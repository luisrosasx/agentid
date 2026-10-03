// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title BehaviorProof
 * @notice Anclaje de recibos de comportamiento (Proof-of-Behavior) y mecanismo
 *         de disputes con slashing. Solo la dirección SLASHER puede imponer slash.
 */
contract BehaviorProof {
    struct Receipt {
        bytes32 root;
        uint64 anchoredAt;
    }

    struct Dispute {
        address challenger;
        bytes32 evidenceRoot;
        uint64 openedAt;
        bool resolved;
        bool upheld;
    }

    address public immutable slasher;
    mapping(uint256 => Receipt) public receipts; // agentId => latest receipt
    mapping(uint256 => Dispute[]) public disputes; // agentId => dispute history
    mapping(uint256 => bool) public slashed; // agentId => slashed
    uint256 public totalSlashed;

    event ReceiptsAnchored(uint256 indexed agentId, bytes32 root, uint64 anchoredAt);
    event DisputeOpened(uint256 indexed agentId, uint256 indexed disputeId, address challenger, bytes32 evidenceRoot);
    event DisputeResolved(uint256 indexed agentId, uint256 indexed disputeId, bool upheld);
    event Slashed(uint256 indexed agentId, address indexed by, uint64 at);

    error NotSlasher();
    error AlreadySlashed();
    error DisputeAlreadyResolved();
    error NoReceipt();

    constructor(address _slasher) {
        slasher = _slasher;
    }

    function anchorReceipts(uint256 agentId, bytes32 root) external {
        receipts[agentId] = Receipt({ root: root, anchoredAt: uint64(block.timestamp) });
        emit ReceiptsAnchored(agentId, root, uint64(block.timestamp));
    }

    function openDispute(uint256 agentId, bytes32 evidenceRoot) external returns (uint256 disputeId) {
        if (receipts[agentId].anchoredAt == 0) revert NoReceipt();
        disputes[agentId].push(
            Dispute({ challenger: msg.sender, evidenceRoot: evidenceRoot, openedAt: uint64(block.timestamp), resolved: false, upheld: false })
        );
        disputeId = disputes[agentId].length - 1;
        emit DisputeOpened(agentId, disputeId, msg.sender, evidenceRoot);
        return disputeId;
    }

    function resolveDispute(uint256 agentId, uint256 disputeId, bool upheld) external {
        if (msg.sender != slasher) revert NotSlasher();
        Dispute storage d = disputes[agentId][disputeId];
        if (d.resolved) revert DisputeAlreadyResolved();
        d.resolved = true;
        d.upheld = upheld;
        emit DisputeResolved(agentId, disputeId, upheld);
    }

    function slash(uint256 agentId) external {
        if (msg.sender != slasher) revert NotSlasher();
        if (slashed[agentId]) revert AlreadySlashed();
        slashed[agentId] = true;
        totalSlashed += 1;
        emit Slashed(agentId, msg.sender, uint64(block.timestamp));
    }

    function disputeCount(uint256 agentId) external view returns (uint256) {
        return disputes[agentId].length;
    }
}
