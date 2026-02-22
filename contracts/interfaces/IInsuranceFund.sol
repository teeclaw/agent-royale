// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IInsuranceFund {
    function deposit() external payable;
    function fundBalance() external view returns (uint256);
}
