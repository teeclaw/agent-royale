// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./CasinoOwnable.sol";
import "./interfaces/IInsuranceFund.sol";

/**
 * @title InsuranceFund
 * @notice Segregated insurance treasury for agent protection.
 *         Funded by 10% skim on casino profits at settlement.
 *         Withdrawals require 3-day timelock.
 *
 * Standalone contract:
 *   - ChannelManager sends insurance skim here on settlement
 *   - Funds are isolated from channel balances
 *   - Can be governed independently (e.g. multisig upgrade later)
 */
contract InsuranceFund is IInsuranceFund, CasinoOwnable, ReentrancyGuard {

    // ─── State ───────────────────────────────────────────────

    address public channelManager; // Only ChannelManager can deposit

    struct WithdrawalRequest {
        uint256 amount;
        address to;
        uint256 requestTime;
    }

    WithdrawalRequest public withdrawalRequest;
    uint256 public constant WITHDRAWAL_DELAY = 3 days;

    // ─── Events ──────────────────────────────────────────────

    event FundDeposited(address indexed from, uint256 amount, uint256 totalFund);
    event WithdrawalRequested(uint256 amount, address to, uint256 executeAfter);
    event WithdrawalExecuted(uint256 amount, address to);
    event WithdrawalCancelled();
    event ChannelManagerUpdated(address indexed oldManager, address indexed newManager);

    // ─── Errors ──────────────────────────────────────────────

    error NotChannelManager();
    error TimelockActive();
    error NoRequest();
    error ExceedsFund();
    error TransferFailed();

    // ─── Constructor ─────────────────────────────────────────

    constructor(address _casino, address _channelManager) CasinoOwnable(_casino) {
        require(_channelManager != address(0), "Zero address");
        channelManager = _channelManager;
    }

    // ─── Deposit (from ChannelManager on settlement) ─────────

    /// @notice ChannelManager sends insurance skim here.
    function deposit() external payable override {
        require(msg.sender == channelManager, "Only ChannelManager");
        emit FundDeposited(msg.sender, msg.value, address(this).balance);
    }

    function fundBalance() external view override returns (uint256) {
        return address(this).balance;
    }

    // ─── Timelock Withdrawal ─────────────────────────────────

    function requestWithdrawal(uint256 amount, address to) external onlyCasino {
        if (amount > address(this).balance) revert ExceedsFund();
        require(to != address(0), "Zero address");

        withdrawalRequest = WithdrawalRequest({
            amount: amount,
            to: to,
            requestTime: block.timestamp
        });

        emit WithdrawalRequested(amount, to, block.timestamp + WITHDRAWAL_DELAY);
    }

    function executeWithdrawal() external onlyCasino nonReentrant {
        if (withdrawalRequest.amount == 0) revert NoRequest();
        if (block.timestamp < withdrawalRequest.requestTime + WITHDRAWAL_DELAY) revert TimelockActive();

        uint256 amount = withdrawalRequest.amount;
        address to = withdrawalRequest.to;
        delete withdrawalRequest;

        (bool success,) = payable(to).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit WithdrawalExecuted(amount, to);
    }

    function cancelWithdrawal() external onlyCasino {
        if (withdrawalRequest.amount == 0) revert NoRequest();
        delete withdrawalRequest;
        emit WithdrawalCancelled();
    }

    // ─── Admin ───────────────────────────────────────────────

    /// @notice Update ChannelManager reference (e.g. after upgrade).
    function setChannelManager(address _new) external onlyCasino {
        require(_new != address(0), "Zero address");
        address old = channelManager;
        channelManager = _new;
        emit ChannelManagerUpdated(old, _new);
    }

    receive() external payable {}
}
