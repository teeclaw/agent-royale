// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./CasinoOwnable.sol";
import "./interfaces/IInsuranceFund.sol";
import "./interfaces/IBankrollManager.sol";

/**
 * @title ChannelManager
 * @notice Core state channel logic. Open, close, dispute.
 *         Delegates exposure tracking to BankrollManager,
 *         insurance skim to InsuranceFund.
 *
 * This is the only contract that holds channel ETH.
 * Modules are referenced by interface and can be upgraded
 * by deploying new versions and calling setters.
 */
contract ChannelManager is CasinoOwnable, ReentrancyGuard, Pausable, EIP712 {
    using ECDSA for bytes32;

    // ─── Types ───────────────────────────────────────────────

    enum ChannelState { None, Open, Disputed, Closed }

    struct Channel {
        uint256 agentDeposit;
        uint256 casinoDeposit;
        uint256 agentBalance;
        uint256 casinoBalance;
        uint256 nonce;
        uint256 openedAt;
        uint256 disputeDeadline;
        ChannelState state;
    }

    // ─── Constants ───────────────────────────────────────────

    uint256 public constant CHALLENGE_PERIOD = 1 days;
    uint256 public constant MIN_DEPOSIT = 0.001 ether;
    uint256 public constant MAX_DEPOSIT = 10 ether;
    uint256 public constant MIN_CHANNEL_DURATION = 1 hours;
    uint256 public constant INSURANCE_BPS = 1000; // 10% of casino profit

    bytes32 public constant CHANNEL_STATE_TYPEHASH = keccak256(
        "ChannelState(address agent,uint256 agentBalance,uint256 casinoBalance,uint256 nonce)"
    );

    // ─── Module References ───────────────────────────────────

    IInsuranceFund public insuranceFund;
    IBankrollManager public bankrollManager;

    // ─── State ───────────────────────────────────────────────

    mapping(address => Channel) public channels;
    mapping(address => uint256) public pendingWithdrawals;

    // ─── Events ──────────────────────────────────────────────

    event ChannelOpened(address indexed agent, uint256 agentDeposit);
    event CasinoFunded(address indexed agent, uint256 amount, uint256 totalCasinoDeposit);
    event ChannelClosed(address indexed agent, uint256 agentPayout, uint256 casinoPayout);
    event ChallengeStarted(address indexed agent, uint256 agentBalance, uint256 nonce, uint256 deadline);
    event ChallengeCountered(address indexed agent, uint256 agentBalance, uint256 nonce, uint256 newDeadline);
    event ChallengeResolved(address indexed agent, uint256 agentPayout, uint256 casinoPayout);
    event WithdrawalPending(address indexed recipient, uint256 amount);
    event ModuleUpdated(string module, address indexed oldAddr, address indexed newAddr);

    // ─── Errors ──────────────────────────────────────────────

    error InvalidDeposit();
    error ChannelExists();
    error ChannelNotOpen();
    error ChannelNotDisputed();
    error StaleNonce();
    error BalanceMismatch();
    error InvalidSignature();
    error ChallengePeriodActive();
    error ChallengeExpired();
    error TooEarly();
    error GamesPlayed();
    error NothingPending();
    error TransferFailed();

    // ─── Constructor ─────────────────────────────────────────

    constructor(
        address _casino,
        address _insuranceFund,
        address _bankrollManager
    )
        CasinoOwnable(_casino)
        EIP712("AgentCasino", "1")
    {
        insuranceFund = IInsuranceFund(_insuranceFund);
        bankrollManager = IBankrollManager(_bankrollManager);
    }

    // ─── Channel Lifecycle ───────────────────────────────────

    /// @notice Agent opens channel with ETH deposit.
    function openChannel() external payable whenNotPaused {
        if (msg.value < MIN_DEPOSIT || msg.value > MAX_DEPOSIT) revert InvalidDeposit();
        if (channels[msg.sender].state != ChannelState.None) revert ChannelExists();

        channels[msg.sender] = Channel({
            agentDeposit: msg.value,
            casinoDeposit: 0,
            agentBalance: msg.value,
            casinoBalance: 0,
            nonce: 0,
            openedAt: block.timestamp,
            disputeDeadline: 0,
            state: ChannelState.Open
        });

        emit ChannelOpened(msg.sender, msg.value);
    }

    /// @notice Casino deposits collateral for an agent's channel.
    function fundCasinoSide(address agent) external payable onlyCasino {
        Channel storage ch = channels[agent];
        if (ch.state != ChannelState.Open) revert ChannelNotOpen();

        // Delegate exposure check to BankrollManager
        bankrollManager.lockCollateral(msg.value);

        ch.casinoDeposit += msg.value;
        ch.casinoBalance += msg.value;

        emit CasinoFunded(agent, msg.value, ch.casinoDeposit);
    }

    /// @notice Cooperative close. Both parties agree on final state.
    function closeChannel(
        uint256 agentBalance,
        uint256 casinoBalance,
        uint256 nonce,
        bytes calldata casinoSig
    ) external nonReentrant {
        Channel storage ch = channels[msg.sender];
        if (ch.state != ChannelState.Open) revert ChannelNotOpen();
        if (nonce <= ch.nonce) revert StaleNonce();
        _checkBalanceInvariant(ch, agentBalance, casinoBalance);
        _verifyCasinoSig(msg.sender, agentBalance, casinoBalance, nonce, casinoSig);

        _settle(msg.sender, ch, agentBalance, casinoBalance);
    }

    // ─── Dispute Resolution ──────────────────────────────────

    function startChallenge(
        uint256 agentBalance,
        uint256 casinoBalance,
        uint256 nonce,
        bytes calldata casinoSig
    ) external {
        Channel storage ch = channels[msg.sender];
        if (ch.state != ChannelState.Open) revert ChannelNotOpen();
        if (nonce <= ch.nonce) revert StaleNonce();
        _checkBalanceInvariant(ch, agentBalance, casinoBalance);
        _verifyCasinoSig(msg.sender, agentBalance, casinoBalance, nonce, casinoSig);

        ch.agentBalance = agentBalance;
        ch.casinoBalance = casinoBalance;
        ch.nonce = nonce;
        ch.state = ChannelState.Disputed;
        ch.disputeDeadline = block.timestamp + CHALLENGE_PERIOD;

        emit ChallengeStarted(msg.sender, agentBalance, nonce, ch.disputeDeadline);
    }

    function counterChallenge(
        address agent,
        uint256 agentBalance,
        uint256 casinoBalance,
        uint256 nonce,
        bytes calldata casinoSig
    ) external {
        Channel storage ch = channels[agent];
        if (ch.state != ChannelState.Disputed) revert ChannelNotDisputed();
        if (block.timestamp >= ch.disputeDeadline) revert ChallengeExpired();
        if (nonce <= ch.nonce) revert StaleNonce();
        _checkBalanceInvariant(ch, agentBalance, casinoBalance);
        _verifyCasinoSig(agent, agentBalance, casinoBalance, nonce, casinoSig);

        ch.agentBalance = agentBalance;
        ch.casinoBalance = casinoBalance;
        ch.nonce = nonce;
        ch.disputeDeadline = block.timestamp + CHALLENGE_PERIOD;

        emit ChallengeCountered(agent, agentBalance, nonce, ch.disputeDeadline);
    }

    function resolveChallenge(address agent) external nonReentrant {
        Channel storage ch = channels[agent];
        if (ch.state != ChannelState.Disputed) revert ChannelNotDisputed();
        if (block.timestamp < ch.disputeDeadline) revert ChallengePeriodActive();

        uint256 agentBal = ch.agentBalance;
        uint256 casinoBal = ch.casinoBalance;

        _settle(agent, ch, agentBal, casinoBal);

        emit ChallengeResolved(agent, agentBal, casinoBal);
    }

    function emergencyExit() external nonReentrant {
        Channel storage ch = channels[msg.sender];
        if (ch.state != ChannelState.Open) revert ChannelNotOpen();
        if (ch.nonce != 0) revert GamesPlayed();
        if (block.timestamp < ch.openedAt + MIN_CHANNEL_DURATION) revert TooEarly();

        _settle(msg.sender, ch, ch.agentDeposit, ch.casinoDeposit);
    }

    // ─── Pull Payment ────────────────────────────────────────

    function withdrawPending() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingPending();

        pendingWithdrawals[msg.sender] = 0;

        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    // ─── Internal ────────────────────────────────────────────

    function _settle(
        address agent,
        Channel storage ch,
        uint256 agentPayout,
        uint256 casinoPayout
    ) internal {
        uint256 casinoDeposit = ch.casinoDeposit;

        // Unlock collateral in BankrollManager
        if (casinoDeposit > 0) {
            bankrollManager.unlockCollateral(casinoDeposit);
        }

        // Insurance: skim 10% of casino profit → InsuranceFund
        uint256 insuranceAmount = 0;
        if (casinoPayout > casinoDeposit) {
            uint256 profit = casinoPayout - casinoDeposit;
            insuranceAmount = (profit * INSURANCE_BPS) / 10000;
            casinoPayout -= insuranceAmount;
        }

        // Delete channel (effects before interactions)
        delete channels[agent];

        // Send insurance skim to InsuranceFund contract
        if (insuranceAmount > 0) {
            insuranceFund.deposit{value: insuranceAmount}();
        }

        // Transfer agent payout
        if (agentPayout > 0) {
            (bool s1,) = payable(agent).call{value: agentPayout}("");
            if (!s1) {
                pendingWithdrawals[agent] += agentPayout;
                emit WithdrawalPending(agent, agentPayout);
            }
        }

        // Transfer casino payout
        if (casinoPayout > 0) {
            (bool s2,) = payable(casino).call{value: casinoPayout}("");
            if (!s2) {
                pendingWithdrawals[casino] += casinoPayout;
                emit WithdrawalPending(casino, casinoPayout);
            }
        }

        emit ChannelClosed(agent, agentPayout, casinoPayout);
    }

    function _verifyCasinoSig(
        address agent,
        uint256 agentBalance,
        uint256 casinoBalance,
        uint256 nonce,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(abi.encode(
            CHANNEL_STATE_TYPEHASH,
            agent,
            agentBalance,
            casinoBalance,
            nonce
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(signature);
        if (signer != casino) revert InvalidSignature();
    }

    function _checkBalanceInvariant(
        Channel storage ch,
        uint256 agentBalance,
        uint256 casinoBalance
    ) internal view {
        if (agentBalance + casinoBalance != ch.agentDeposit + ch.casinoDeposit) {
            revert BalanceMismatch();
        }
    }

    /// @dev Block ownership transfer while channels have locked collateral.
    function _canTransfer() internal view override returns (bool) {
        return bankrollManager.totalLocked() == 0;
    }

    // ─── Admin ───────────────────────────────────────────────

    function pause() external onlyCasino { _pause(); }
    function unpause() external onlyCasino { _unpause(); }

    function setInsuranceFund(address _new) external onlyCasino {
        require(_new != address(0), "Zero address");
        address old = address(insuranceFund);
        insuranceFund = IInsuranceFund(_new);
        emit ModuleUpdated("InsuranceFund", old, _new);
    }

    function setBankrollManager(address _new) external onlyCasino {
        require(_new != address(0), "Zero address");
        address old = address(bankrollManager);
        bankrollManager = IBankrollManager(_new);
        emit ModuleUpdated("BankrollManager", old, _new);
    }

    // ─── View ────────────────────────────────────────────────

    function getChannel(address agent) external view returns (Channel memory) {
        return channels[agent];
    }

    function isPlayable(address agent) external view returns (bool) {
        Channel memory ch = channels[agent];
        return ch.state == ChannelState.Open && ch.casinoDeposit > 0;
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    receive() external payable {}
}
