// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CountersignOracle} from "./CountersignOracle.sol";

/// @title CountersignEscrow
/// @notice USDC escrow on Arc that releases or refunds on a TEE-attested LLM verdict.
///         Anyone may submit a bundle; only a bundle whose every text was signed by a
///         registered 0G enclave signer, bound to this escrow's rubric and evidence, moves funds.
contract CountersignEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { None, Open, Resolved, Refunded, Escalated }

    struct Escrow {
        address payer;
        address payee;
        address arbiter;        // optional human fallback on Escalated; address(0) = none
        uint96 amount;          // ERC-20 USDC units (6 decimals on Arc)
        uint64 deadline;        // unix seconds; after it, payer may refund if not Resolved
        bytes32 rubricHash;     // keccak256(bytes(rubric))
        bytes32 evidenceHash;   // keccak256(bytes(evidence)), set once by payee
        CountersignOracle.Policy policy;
        State state;
    }

    IERC20 public immutable usdc;
    CountersignOracle public immutable oracle;
    uint256 public nonce;
    mapping(bytes32 => Escrow) public escrows;

    event Opened(bytes32 indexed id, address indexed payer, address indexed payee, uint96 amount, uint64 deadline, bytes32 rubricHash, string rubric);
    event EvidenceSet(bytes32 indexed id, bytes32 evidenceHash, string storageRef);
    event Settled(bytes32 indexed id, uint8 outcome, address[] signers, string[] requestIds);
    event Arbitrated(bytes32 indexed id, bool released, address arbiter);
    event RefundedAfterDeadline(bytes32 indexed id);

    error NotOpen();
    error NotPayee();
    error NotPayer();
    error NotArbiter();
    error EvidenceAlreadySet();
    error EvidenceMissing();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error BadPolicy();

    constructor(IERC20 usdc_, CountersignOracle oracle_) {
        usdc = usdc_;
        oracle = oracle_;
    }

    /// @notice Lock `amount` USDC against a rubric. The rubric text is emitted for transparency;
    ///         only its hash is stored.
    function open(
        address payee,
        address arbiter,
        uint96 amount,
        uint64 deadline,
        string calldata rubric,
        CountersignOracle.Policy calldata policy
    ) external nonReentrant returns (bytes32 id) {
        if (policy.judges == 0 || policy.minAgree == 0 || policy.minAgree > policy.judges || policy.minConfBps > 10000) {
            revert BadPolicy();
        }
        if (deadline <= block.timestamp) revert DeadlinePassed();
        bytes32 rubricHash = keccak256(bytes(rubric));
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, payee, rubricHash, nonce++));
        escrows[id] = Escrow({
            payer: msg.sender,
            payee: payee,
            arbiter: arbiter,
            amount: amount,
            deadline: deadline,
            rubricHash: rubricHash,
            evidenceHash: bytes32(0),
            policy: policy,
            state: State.Open
        });
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Opened(id, msg.sender, payee, amount, deadline, rubricHash, rubric);
    }

    /// @notice Payee commits the evidence hash once. `storageRef` is a pointer (e.g. 0G Storage root).
    function setEvidence(bytes32 id, bytes32 evidenceHash, string calldata storageRef) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert NotOpen();
        if (msg.sender != e.payee) revert NotPayee();
        if (e.evidenceHash != bytes32(0)) revert EvidenceAlreadySet();
        if (block.timestamp > e.deadline) revert DeadlinePassed();
        e.evidenceHash = evidenceHash;
        emit EvidenceSet(id, evidenceHash, storageRef);
    }

    /// @notice Submit a verdict bundle. Reverts if any attestation is invalid for this escrow.
    function settle(
        bytes32 id,
        CountersignOracle.Attested[] calldata judges,
        CountersignOracle.Attested calldata grounding,
        CountersignOracle.Attested calldata calibration,
        string[] calldata requestIds
    ) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert NotOpen();
        if (e.evidenceHash == bytes32(0)) revert EvidenceMissing();
        if (block.timestamp > e.deadline) revert DeadlinePassed();

        (uint8 outcome, address[] memory signers) =
            oracle.resolve(e.rubricHash, e.evidenceHash, e.policy, judges, grounding, calibration);

        if (outcome == oracle.YES()) {
            e.state = State.Resolved;
            usdc.safeTransfer(e.payee, e.amount);
        } else if (outcome == oracle.NO()) {
            e.state = State.Refunded;
            usdc.safeTransfer(e.payer, e.amount);
        } else {
            e.state = State.Escalated;
        }
        emit Settled(id, outcome, signers, requestIds);
    }

    /// @notice Human fallback once the oracle escalated.
    function arbitrate(bytes32 id, bool release) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.state != State.Escalated) revert NotOpen();
        if (msg.sender != e.arbiter || e.arbiter == address(0)) revert NotArbiter();
        if (release) {
            e.state = State.Resolved;
            usdc.safeTransfer(e.payee, e.amount);
        } else {
            e.state = State.Refunded;
            usdc.safeTransfer(e.payer, e.amount);
        }
        emit Arbitrated(id, release, msg.sender);
    }

    /// @notice After the deadline with no accepted verdict, the payer takes the funds back.
    function refundAfterDeadline(bytes32 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.state != State.Open && e.state != State.Escalated) revert NotOpen();
        if (msg.sender != e.payer) revert NotPayer();
        if (block.timestamp <= e.deadline) revert DeadlineNotPassed();
        e.state = State.Refunded;
        usdc.safeTransfer(e.payer, e.amount);
        emit RefundedAfterDeadline(id);
    }

    function get(bytes32 id) external view returns (Escrow memory) {
        return escrows[id];
    }
}
