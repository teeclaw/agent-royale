// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./CasinoOwnable.sol";
import "./interfaces/IBankrollManager.sol";

/**
 * @title BankrollManager
 * @notice Tracks casino collateral exposure across all channels.
 *         ChannelManager calls lock/unlock on fund/settle.
 *         Casino operator sets max exposure cap.
 *
 * Standalone so bankroll strategy (caps, dynamic limits) can
 * evolve without touching channel or insurance logic.
 */
contract BankrollManager is IBankrollManager, CasinoOwnable {

    // ─── State ───────────────────────────────────────────────

    address public channelManager;
    uint256 public totalLocked;
    uint256 public maxExposure;

    // ─── Events ──────────────────────────────────────────────

    event CollateralLocked(uint256 amount, uint256 totalLocked);
    event CollateralUnlocked(uint256 amount, uint256 totalLocked);
    event MaxExposureUpdated(uint256 oldMax, uint256 newMax);
    event ChannelManagerUpdated(address indexed oldManager, address indexed newManager);

    // ─── Errors ──────────────────────────────────────────────

    error NotChannelManager();
    error ExposureLimitReached();
    error InsufficientLocked();

    modifier onlyChannelManager() {
        if (msg.sender != channelManager) revert NotChannelManager();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────

    constructor(address _casino, address _channelManager, uint256 _maxExposure) CasinoOwnable(_casino) {
        require(_channelManager != address(0), "Zero address");
        channelManager = _channelManager;
        maxExposure = _maxExposure;
    }

    // ─── Lock/Unlock (called by ChannelManager) ──────────────

    function lockCollateral(uint256 amount) external override onlyChannelManager {
        if (totalLocked + amount > maxExposure) revert ExposureLimitReached();
        totalLocked += amount;
        emit CollateralLocked(amount, totalLocked);
    }

    function unlockCollateral(uint256 amount) external override onlyChannelManager {
        if (amount > totalLocked) revert InsufficientLocked();
        totalLocked -= amount;
        emit CollateralUnlocked(amount, totalLocked);
    }

    function canLock(uint256 amount) external view override returns (bool) {
        return totalLocked + amount <= maxExposure;
    }

    // ─── Admin ───────────────────────────────────────────────

    function setMaxExposure(uint256 _max) external onlyCasino {
        uint256 old = maxExposure;
        maxExposure = _max;
        emit MaxExposureUpdated(old, _max);
    }

    function setChannelManager(address _new) external onlyCasino {
        require(_new != address(0), "Zero address");
        address old = channelManager;
        channelManager = _new;
        emit ChannelManagerUpdated(old, _new);
    }

    /// @dev Block ownership transfer while collateral is locked.
    function _canTransfer() internal view override returns (bool) {
        return totalLocked == 0;
    }
}
