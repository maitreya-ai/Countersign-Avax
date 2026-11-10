// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SignerRegistry} from "../src/SignerRegistry.sol";
import {CountersignOracle} from "../src/CountersignOracle.sol";
import {CountersignEscrow} from "../src/CountersignEscrow.sol";
import {CountersignValidator} from "../src/CountersignValidator.sol";
import {IIdentityRegistry, IValidationRegistry} from "../src/interfaces/IERC8004.sol";

/// Deploys the Countersign contracts. On chains without the ERC-8004 Validation Registry (C-Chain mainnet
/// today), leave ERC8004_VALIDATION empty and the validator is skipped.
///   forge script script/Deploy.s.sol --rpc-url fuji --broadcast
/// Env: DEPLOYER_PRIVATE_KEY, USDC, ERC8004_IDENTITY, ERC8004_VALIDATION, NODE_URL
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);
        address usdc = vm.envAddress("USDC");
        address validationAddr = vm.envOr("ERC8004_VALIDATION", address(0));
        address identityAddr = vm.envOr("ERC8004_IDENTITY", address(0));
        string memory baseURI = string.concat(vm.envOr("NODE_URL", string("http://localhost:8402")), "/escrows/");

        vm.startBroadcast(pk);
        SignerRegistry registry = new SignerRegistry(owner);
        CountersignOracle oracle = new CountersignOracle(registry);
        CountersignEscrow escrow = new CountersignEscrow(IERC20(usdc), oracle);
        CountersignValidator validator;
        if (validationAddr != address(0)) {
            validator = new CountersignValidator(
                IValidationRegistry(validationAddr), IIdentityRegistry(identityAddr), escrow, baseURI, owner
            );
        }
        vm.stopBroadcast();

        console.log("SIGNER_REGISTRY=%s", address(registry));
        console.log("COUNTERSIGN_ORACLE=%s", address(oracle));
        console.log("COUNTERSIGN_ESCROW=%s", address(escrow));
        console.log("COUNTERSIGN_VALIDATOR=%s", address(validator));
    }
}
