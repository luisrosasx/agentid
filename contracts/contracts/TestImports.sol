// SPDX-License-Identifier: Apache-2.0
// Solo para tests: fuerza la compilación del proxy ERC1967 (deploy UUPS de
// InterchangeSettlement en los tests de Hardhat).
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract TestImports {
    constructor() {
        require(address(new ERC1967Proxy(address(1), "")) != address(0));
    }
}
