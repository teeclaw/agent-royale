// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRelayRouter {
    function relayFund(address stealthAddress) external payable;
}
