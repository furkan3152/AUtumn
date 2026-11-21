// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {GoldBuyer} from "../src/GoldBuyer.sol";

/// @notice Deploys GoldBuyer. It takes no constructor arguments and has nothing to configure afterwards.
/// Dry run (simulation only): forge script script/Deploy.s.sol --fork-url https://forno.celo.org --fork-block-number 83384000
/// (Adding --broadcast and a key would send a real transaction; this project has not done so.)
contract Deploy is Script {
    function run() external returns (GoldBuyer buyer) {
        vm.startBroadcast();
        buyer = new GoldBuyer();
        vm.stopBroadcast();
    }
}
