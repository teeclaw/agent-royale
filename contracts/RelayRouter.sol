// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./CasinoOwnable.sol";
import "./interfaces/IRelayRouter.sol";

/**
 * @title RelayRouter
 * @notice Privacy relay for funding stealth addresses.
 *         Casino sends ETH here, router forwards to stealth address.
 *         No onchain link between agent identity and funded address.
 *
 * Standalone so relay logic (batching, fee tiers, privacy upgrades)
 * can evolve without touching channels.
 */
contract RelayRouter is IRelayRouter, CasinoOwnable {

    // ─── State ───────────────────────────────────────────────

    uint256 public totalRelayed;
    uint256 public relayCount;
    bool public relayEnabled;

    // ─── Events ──────────────────────────────────────────────

    event RelayFunded(address indexed stealthAddress, uint256 amount);
    event RelayToggled(bool enabled);

    // ─── Errors ──────────────────────────────────────────────

    error RelayDisabled();
    error TransferFailed();
    error ZeroAddress();
    error ZeroAmount();

    // ─── Constructor ─────────────────────────────────────────

    constructor(address _casino) CasinoOwnable(_casino) {
        relayEnabled = true;
    }

    // ─── Relay ───────────────────────────────────────────────

    /// @notice Fund a stealth address. Only casino can call.
    function relayFund(address stealthAddress) external payable override onlyCasino {
        if (!relayEnabled) revert RelayDisabled();
        if (stealthAddress == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        (bool success,) = payable(stealthAddress).call{value: msg.value}("");
        if (!success) revert TransferFailed();

        totalRelayed += msg.value;
        relayCount++;

        emit RelayFunded(stealthAddress, msg.value);
    }

    // ─── Admin ───────────────────────────────────────────────

    function setRelayEnabled(bool _enabled) external onlyCasino {
        relayEnabled = _enabled;
        emit RelayToggled(_enabled);
    }

    /// @notice Recover stuck ETH (shouldn't happen, but just in case).
    function recoverETH(address to) external onlyCasino {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        (bool success,) = payable(to).call{value: bal}("");
        if (!success) revert TransferFailed();
    }

    receive() external payable {}
}
