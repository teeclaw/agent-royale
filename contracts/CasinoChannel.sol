// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title CasinoChannel
 * @notice Privacy-first state channel for agent casino on Base.
 *         Two-party channels (agent + casino collateral).
 *         EIP-712 typed signatures. Bidirectional disputes.
 *         Pull payment fallback. Insurance fund.
 */
contract CasinoChannel is ReentrancyGuard, Pausable, EIP712 {
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

    // ─── State ───────────────────────────────────────────────

    address public casino;
    address public pendingCasino;
    uint256 public insuranceFund;
    uint256 public totalCasinoLocked;
    uint256 public maxCasinoExposure;

    mapping(address => Channel) public channels;
    mapping(address => uint256) public pendingWithdrawals;

    // ─── Events ──────────────────────────────────────────────

    event ChannelOpened(address indexed agent, uint256 agentDeposit);
    event CasinoFunded(address indexed agent, uint256 amount, uint256 totalCasinoDeposit);
    event ChannelClosed(address indexed agent, uint256 agentPayout, uint256 casinoPayout);
    event ChallengeStarted(address indexed agent, uint256 agentBalance, uint256 nonce, uint256 deadline);
    event ChallengeCountered(address indexed agent, uint256 agentBalance, uint256 nonce, uint256 newDeadline);
    event ChallengeResolved(address indexed agent, uint256 agentPayout, uint256 casinoPayout);
    event RelayFunded(address indexed stealthAddress, uint256 amount);
    event InsuranceDeposited(uint256 amount, uint256 totalFund);
    event WithdrawalPending(address indexed recipient, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────

    error NotCasino();
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
    error ExposureLimitReached();
    error NothingPending();
    error TransferFailed();

    // ─── Modifiers ───────────────────────────────────────────

    modifier onlyCasino() {
        if (msg.sender != casino) revert NotCasino();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────

    constructor(address _casino, uint256 _maxExposure)
        EIP712("AgentCasino", "1")
    {
        casino = _casino;
        maxCasinoExposure = _maxExposure;
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
        if (totalCasinoLocked + msg.value > maxCasinoExposure) revert ExposureLimitReached();

        ch.casinoDeposit += msg.value;
        ch.casinoBalance += msg.value;
        totalCasinoLocked += msg.value;

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

    /// @notice Agent starts challenge with their latest signed state.
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

    /// @notice Either party counters with a higher-nonce signed state.
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

    /// @notice Finalize after challenge period expires.
    function resolveChallenge(address agent) external nonReentrant {
        Channel storage ch = channels[agent];
        if (ch.state != ChannelState.Disputed) revert ChannelNotDisputed();
        if (block.timestamp < ch.disputeDeadline) revert ChallengePeriodActive();

        uint256 agentBal = ch.agentBalance;
        uint256 casinoBal = ch.casinoBalance;

        _settle(agent, ch, agentBal, casinoBal);

        emit ChallengeResolved(agent, agentBal, casinoBal);
    }

    /// @notice Agent emergency exit if NO games played and casino unresponsive.
    function emergencyExit() external nonReentrant {
        Channel storage ch = channels[msg.sender];
        if (ch.state != ChannelState.Open) revert ChannelNotOpen();
        if (ch.nonce != 0) revert GamesPlayed();
        if (block.timestamp < ch.openedAt + MIN_CHANNEL_DURATION) revert TooEarly();

        _settle(msg.sender, ch, ch.agentDeposit, ch.casinoDeposit);
    }

    // ─── Pull Payment ────────────────────────────────────────

    /// @notice Claim pending withdrawal (fallback for failed transfers).
    function withdrawPending() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingPending();

        pendingWithdrawals[msg.sender] = 0;

        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    // ─── Relay Funding (Privacy) ─────────────────────────────

    /// @notice Casino funds a stealth address. No onchain link to agent.
    function relayFund(address stealthAddress) external payable onlyCasino {
        require(stealthAddress != address(0), "Zero address");

        (bool success,) = payable(stealthAddress).call{value: msg.value}("");
        if (!success) revert TransferFailed();

        emit RelayFunded(stealthAddress, msg.value);
    }

    // ─── Internal ────────────────────────────────────────────

    function _settle(
        address agent,
        Channel storage ch,
        uint256 agentPayout,
        uint256 casinoPayout
    ) internal {
        uint256 casinoDeposit = ch.casinoDeposit;

        // Unlock casino collateral tracking
        totalCasinoLocked -= casinoDeposit;

        // Insurance: skim 10% of casino profit
        uint256 insuranceAmount = 0;
        if (casinoPayout > casinoDeposit) {
            uint256 profit = casinoPayout - casinoDeposit;
            insuranceAmount = (profit * INSURANCE_BPS) / 10000;
            casinoPayout -= insuranceAmount;
            insuranceFund += insuranceAmount;
            emit InsuranceDeposited(insuranceAmount, insuranceFund);
        }

        // Delete channel (effects before interactions)
        delete channels[agent];

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

    // ─── Admin ───────────────────────────────────────────────

    function pause() external onlyCasino { _pause(); }
    function unpause() external onlyCasino { _unpause(); }

    function setMaxExposure(uint256 _max) external onlyCasino {
        maxCasinoExposure = _max;
    }

    // ─── Ownership Transfer (Secure) ─────────────────────────
    //
    // 3-step process with timelock:
    //   1. Current owner initiates transfer → starts 2-day timelock
    //   2. After timelock, new owner accepts
    //   3. Current owner can cancel anytime before acceptance
    //
    // Safety:
    //   - Blocks transfer while any channels are open (funds at risk)
    //   - 2-day delay gives time to detect compromised keys
    //   - Zero-address protection
    //   - Full event trail for monitoring

    uint256 public constant OWNERSHIP_TRANSFER_DELAY = 2 days;
    uint256 public transferRequestTime;

    event OwnershipTransferRequested(address indexed from, address indexed to, uint256 executeAfter);
    event OwnershipTransferCompleted(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferCancelled(address indexed cancelledBy);

    error ActiveChannelsExist();
    error TransferNotReady();
    error NoPendingTransfer();

    /// @notice Step 1: Initiate ownership transfer (2-day timelock).
    ///         Requires no open channels to prevent mid-game ownership confusion.
    function transferCasino(address _new) external onlyCasino {
        require(_new != address(0), "Zero address");
        require(_new != casino, "Already owner");

        // Block if any casino collateral is locked in channels
        if (totalCasinoLocked > 0) revert ActiveChannelsExist();

        pendingCasino = _new;
        transferRequestTime = block.timestamp;

        emit OwnershipTransferRequested(casino, _new, block.timestamp + OWNERSHIP_TRANSFER_DELAY);
    }

    /// @notice Step 2: New owner accepts after timelock expires.
    function acceptCasino() external {
        require(msg.sender == pendingCasino, "Not pending");
        require(pendingCasino != address(0), "No pending transfer");
        if (block.timestamp < transferRequestTime + OWNERSHIP_TRANSFER_DELAY) revert TransferNotReady();

        // Re-check no channels opened during timelock
        if (totalCasinoLocked > 0) revert ActiveChannelsExist();

        address oldOwner = casino;
        casino = pendingCasino;
        pendingCasino = address(0);
        transferRequestTime = 0;

        emit OwnershipTransferCompleted(oldOwner, casino);
    }

    /// @notice Cancel pending transfer. Only current owner.
    function cancelTransferCasino() external onlyCasino {
        if (pendingCasino == address(0)) revert NoPendingTransfer();

        pendingCasino = address(0);
        transferRequestTime = 0;

        emit OwnershipTransferCancelled(msg.sender);
    }

    // ─── Insurance Timelock [FIX #5] ───────────────────────

    struct InsuranceRequest {
        uint256 amount;
        address to;
        uint256 requestTime;
    }

    InsuranceRequest public insuranceRequest;
    uint256 public constant INSURANCE_WITHDRAWAL_DELAY = 3 days;

    event InsuranceWithdrawalRequested(uint256 amount, address to, uint256 executeAfter);
    event InsuranceWithdrawalExecuted(uint256 amount, address to);
    event InsuranceWithdrawalCancelled();

    /// @notice Request insurance withdrawal (3-day timelock).
    function requestInsuranceWithdrawal(uint256 amount, address to) external onlyCasino {
        require(amount <= insuranceFund, "Exceeds fund");
        require(to != address(0), "Zero address");

        insuranceRequest = InsuranceRequest({
            amount: amount,
            to: to,
            requestTime: block.timestamp
        });

        emit InsuranceWithdrawalRequested(amount, to, block.timestamp + INSURANCE_WITHDRAWAL_DELAY);
    }

    /// @notice Execute after timelock expires.
    function executeInsuranceWithdrawal() external onlyCasino {
        require(insuranceRequest.amount > 0, "No pending request");
        require(
            block.timestamp >= insuranceRequest.requestTime + INSURANCE_WITHDRAWAL_DELAY,
            "Timelock active"
        );

        uint256 amount = insuranceRequest.amount;
        address to = insuranceRequest.to;
        delete insuranceRequest;

        insuranceFund -= amount;
        (bool success,) = payable(to).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit InsuranceWithdrawalExecuted(amount, to);
    }

    /// @notice Cancel pending insurance withdrawal.
    function cancelInsuranceWithdrawal() external onlyCasino {
        delete insuranceRequest;
        emit InsuranceWithdrawalCancelled();
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
