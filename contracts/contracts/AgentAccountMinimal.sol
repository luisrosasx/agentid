// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title AgentAccountMinimal
 * @notice Cuenta Agentil mínima: política de gasto on-chain con límite diario,
 *         allowlist de destinos y ejecución de pagos que revierte si se excede
 *         el límite diario o el destino no está permitido.
 */
contract AgentAccountMinimal {
    struct Policy {
        uint256 dailyLimitWei;
        uint256 currentDay; // día (epoch / 1 days) activo
        uint256 spentToday;
        mapping(address => bool) allowedTargets;
    }

    address public owner;
    mapping(address => Policy) private _policies; // owner => policy (una cuenta por owner)

    event DailyLimitSet(address indexed owner, uint256 limitWei);
    event TargetAllowed(address indexed owner, address indexed target, bool allowed);
    event Executed(address indexed owner, address indexed target, uint256 value, uint256 spentToday);
    event Deposit(address indexed from, uint256 amount);

    error NotOwner();
    error TargetNotAllowed();
    error DailyLimitExceeded();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    function setDailyLimit(uint256 limitWei) external onlyOwner {
        Policy storage p = _policies[owner];
        p.dailyLimitWei = limitWei;
        emit DailyLimitSet(owner, limitWei);
    }

    function setTargetAllowed(address target, bool allowed) external onlyOwner {
        _policies[owner].allowedTargets[target] = allowed;
        emit TargetAllowed(owner, target, allowed);
    }

    function policy() external view returns (uint256 dailyLimitWei, uint256 currentDay, uint256 spentToday) {
        Policy storage p = _policies[owner];
        return (p.dailyLimitWei, p.currentDay, p.spentToday);
    }

    function isTargetAllowed(address target) external view returns (bool) {
        return _policies[owner].allowedTargets[target];
    }

    function _rollDay(Policy storage p) internal {
        uint256 day = block.timestamp / 1 days;
        if (p.currentDay != day) {
            p.currentDay = day;
            p.spentToday = 0;
        }
    }

    /**
     * @notice Ejecuta un pago desde la cuenta respetando la política de gasto.
     */
    function execute(address payable target, uint256 value) external onlyOwner {
        Policy storage p = _policies[owner];
        if (!p.allowedTargets[target]) revert TargetNotAllowed();

        _rollDay(p);
        if (p.spentToday + value > p.dailyLimitWei) revert DailyLimitExceeded();

        p.spentToday += value;
        (bool ok, ) = target.call{value: value}("");
        if (!ok) revert TransferFailed();

        emit Executed(owner, target, value, p.spentToday);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
