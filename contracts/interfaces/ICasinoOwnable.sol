// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ICasinoOwnable
 * @notice Shared ownership interface for all casino modules.
 */
interface ICasinoOwnable {
    function casino() external view returns (address);
}
