// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBankrollManager {
    function lockCollateral(uint256 amount) external;
    function unlockCollateral(uint256 amount) external;
    function canLock(uint256 amount) external view returns (bool);
    function totalLocked() external view returns (uint256);
    function maxExposure() external view returns (uint256);
}
