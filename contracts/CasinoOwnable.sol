// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CasinoOwnable
 * @notice Shared ownership base with secure 2-step + timelock transfer.
 *         All casino modules inherit this.
 *
 * Transfer flow:
 *   1. Owner calls transferCasino(newOwner) → 2-day timelock starts
 *   2. After timelock, new owner calls acceptCasino()
 *   3. Owner can cancelTransferCasino() anytime before acceptance
 */
abstract contract CasinoOwnable {
    address public casino;
    address public pendingCasino;
    uint256 public transferRequestTime;

    uint256 public constant OWNERSHIP_TRANSFER_DELAY = 2 days;

    event OwnershipTransferRequested(address indexed from, address indexed to, uint256 executeAfter);
    event OwnershipTransferCompleted(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferCancelled(address indexed cancelledBy);

    error NotCasino();
    error TransferNotReady();
    error NoPendingTransfer();

    modifier onlyCasino() {
        if (msg.sender != casino) revert NotCasino();
        _;
    }

    constructor(address _casino) {
        require(_casino != address(0), "Zero address");
        casino = _casino;
    }

    /// @dev Override to add pre-transfer checks (e.g. no active channels).
    function _canTransfer() internal view virtual returns (bool) {
        return true;
    }

    function transferCasino(address _new) external onlyCasino {
        require(_new != address(0), "Zero address");
        require(_new != casino, "Already owner");
        require(_canTransfer(), "Transfer blocked");

        pendingCasino = _new;
        transferRequestTime = block.timestamp;

        emit OwnershipTransferRequested(casino, _new, block.timestamp + OWNERSHIP_TRANSFER_DELAY);
    }

    function acceptCasino() external {
        require(msg.sender == pendingCasino, "Not pending");
        require(pendingCasino != address(0), "No pending transfer");
        if (block.timestamp < transferRequestTime + OWNERSHIP_TRANSFER_DELAY) revert TransferNotReady();
        require(_canTransfer(), "Transfer blocked");

        address oldOwner = casino;
        casino = pendingCasino;
        pendingCasino = address(0);
        transferRequestTime = 0;

        emit OwnershipTransferCompleted(oldOwner, casino);
    }

    function cancelTransferCasino() external onlyCasino {
        if (pendingCasino == address(0)) revert NoPendingTransfer();
        pendingCasino = address(0);
        transferRequestTime = 0;
        emit OwnershipTransferCancelled(msg.sender);
    }
}
