// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {CountersignOracle} from "./CountersignOracle.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title CountersignEscrow
/// @notice Holds a USDC payment until a quorum of signed LLM judges decides whether the seller's
///         delivery met the promise (the rubric). The oracle re-checks every signature against the
///         exact request/response bytes, so no keeper, relayer or facilitator is trusted with funds.
///
///         Two ways in:
///         - `open`: the payer approves and calls it directly.
///         - `openWithAuthorization`: the x402 `countersign` scheme. The buyer signs one gasless EIP-3009
///           `ReceiveWithAuthorization` whose nonce IS the hash of the escrow terms. USDC only lets
///           `to` (this contract) redeem it, so nobody can front-run it, and changing any term
///           changes the nonce and breaks the USDC signature check.
///
///         The seller signs an EIP-712 receipt for the evidence it served. Evidence is accepted only
///         with that signature, and a second, different signed receipt is a proof of equivocation
///         that refunds the buyer.
contract CountersignEscrow is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum State { None, Open, Resolved, Refunded, Escalated }

    /// @notice Why an escrow ended. Read by CountersignValidator to score the seller.
    enum Reason { None, VerdictYes, VerdictNo, ArbiterRelease, ArbiterRefund, DeadlineRefund, Equivocation }

    struct Escrow {
        address payer;
        address payee;
        address arbiter;        // optional human fallback on Escalated; address(0) = none
        uint96 amount;          // USDC atomic units (6 decimals)
        uint64 deadline;        // unix seconds; after it, anyone may refund the payer if not final
        bytes32 rubricHash;     // keccak256(bytes(rubric))
        bytes32 evidenceHash;   // keccak256(bytes(evidence)), set once
        CountersignOracle.Policy policy;
        State state;
        Reason reason;
        uint256 agentId;        // payee's ERC-8004 agent id, signed into the terms; NO_AGENT = none
    }

    /// @notice Arguments of `openWithAuthorization` (a struct keeps calldata readable and the stack shallow).
    struct OpenAuth {
        address payer;          // EIP-3009 `from`
        address payee;
        address arbiter;
        uint96 amount;
        uint64 deadline;
        uint256 agentId;
        bytes32 salt;           // buyer-chosen randomness, part of the terms
        uint256 validAfter;     // EIP-3009 validity window
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    uint256 public constant NO_AGENT = type(uint256).max;
    bytes32 public constant TERMS_TAG = keccak256("countersign.terms.v1");
    bytes32 public constant RECEIPT_TYPEHASH = keccak256("Receipt(bytes32 escrowId,bytes32 evidenceHash)");

    IERC20 public immutable usdc;
    CountersignOracle public immutable oracle;
    uint256 public nonce;
    mapping(bytes32 => Escrow) public escrows;

    event Opened(bytes32 indexed id, address indexed payer, address indexed payee, uint96 amount, uint64 deadline, bytes32 rubricHash, string rubric);
    event OpenedWithAuthorization(bytes32 indexed id, bytes32 termsNonce, bytes32 salt, uint256 agentId);
    event EvidenceSet(bytes32 indexed id, bytes32 evidenceHash, string storageRef);
    event Equivocated(bytes32 indexed id, bytes32 storedEvidenceHash, bytes32 otherEvidenceHash);
    event Settled(bytes32 indexed id, uint8 outcome, address[] signers, string[] requestIds);
    event Arbitrated(bytes32 indexed id, bool released, address arbiter);
    event RefundedAfterDeadline(bytes32 indexed id);

    error NotOpen();
    error NotPayee();
    error NotArbiter();
    error EvidenceAlreadySet();
    error EvidenceMissing();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error BadPolicy();
    error BadTerms();
    error IdInUse();
    error BadReceipt();
    error NotEquivocation();

    constructor(IERC20 usdc_, CountersignOracle oracle_) EIP712("CountersignEscrow", "1") {
        usdc = usdc_;
        oracle = oracle_;
    }

    // ---- terms ---------------------------------------------------------------

    /// @notice The escrow terms as one hash. For `openWithAuthorization` this value is the EIP-3009 nonce.
    function termsHash(
        address payee,
        address arbiter,
        uint96 amount,
        uint64 deadline,
        bytes32 rubricHash,
        CountersignOracle.Policy memory policy,
        uint256 agentId,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                TERMS_TAG, block.chainid, address(this), payee, arbiter, amount, deadline, rubricHash, policy, agentId, salt
            )
        );
    }

    /// @notice Escrow id of an authorised open. Unique because USDC never accepts a nonce twice per payer.
    function escrowIdFor(address payer, bytes32 termsNonce) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, termsNonce));
    }

    // ---- open ----------------------------------------------------------------

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
        _checkPolicy(policy);
        if (deadline <= block.timestamp) revert DeadlinePassed();
        bytes32 rubricHash = keccak256(bytes(rubric));
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, payee, rubricHash, nonce++));
        _store(id, msg.sender, payee, arbiter, amount, deadline, rubricHash, policy, NO_AGENT);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Opened(id, msg.sender, payee, amount, deadline, rubricHash, rubric);
    }

    /// @notice Open an escrow from the buyer's gasless EIP-3009 authorisation. Anyone may submit it
    ///         (normally the seller's x402 middleware or a facilitator); the terms are exactly what
    ///         the buyer signed, because they are the nonce.
    function openWithAuthorization(OpenAuth calldata a, string calldata rubric, CountersignOracle.Policy calldata policy)
        external
        nonReentrant
        returns (bytes32 id)
    {
        _checkPolicy(policy);
        if (a.deadline <= block.timestamp) revert DeadlinePassed();
        if (a.amount == 0 || a.payee == address(0) || a.payer == address(0)) revert BadTerms();
        bytes32 rubricHash = keccak256(bytes(rubric));
        bytes32 termsNonce = termsHash(a.payee, a.arbiter, a.amount, a.deadline, rubricHash, policy, a.agentId, a.salt);
        id = escrowIdFor(a.payer, termsNonce);
        if (escrows[id].state != State.None) revert IdInUse();

        _store(id, a.payer, a.payee, a.arbiter, a.amount, a.deadline, rubricHash, policy, a.agentId);
        IERC3009(address(usdc)).receiveWithAuthorization(
            a.payer, address(this), a.amount, a.validAfter, a.validBefore, termsNonce, a.v, a.r, a.s
        );
        emit Opened(id, a.payer, a.payee, a.amount, a.deadline, rubricHash, rubric);
        emit OpenedWithAuthorization(id, termsNonce, a.salt, a.agentId);
    }

    // ---- evidence ------------------------------------------------------------

    /// @notice EIP-712 digest the seller signs for the evidence it served under escrow `id`.
    function receiptDigest(bytes32 id, bytes32 evidenceHash) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RECEIPT_TYPEHASH, id, evidenceHash)));
    }

    /// @notice Payee commits the evidence hash once. `storageRef` is a pointer to the evidence bytes.
    function setEvidence(bytes32 id, bytes32 evidenceHash, string calldata storageRef) external {
        if (msg.sender != escrows[id].payee) revert NotPayee();
        _setEvidence(id, evidenceHash, storageRef);
    }

    /// @notice Anyone commits the evidence with the payee's signed receipt. The buyer (or the keeper)
    ///         can do this when the seller withholds it, so a seller cannot dodge judgement.
    function setEvidenceWithReceipt(bytes32 id, bytes32 evidenceHash, string calldata storageRef, bytes calldata payeeSig)
        external
    {
        if (!_validReceipt(id, evidenceHash, payeeSig)) revert BadReceipt();
        _setEvidence(id, evidenceHash, storageRef);
    }

    /// @notice The payee signed receipts for two different evidence hashes under the same escrow:
    ///         it served one thing and committed another. Refund the buyer.
    function proveEquivocation(bytes32 id, bytes32 otherEvidenceHash, bytes calldata payeeSig) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.state != State.Open && e.state != State.Escalated) revert NotOpen();
        if (e.evidenceHash == bytes32(0)) revert EvidenceMissing();
        if (otherEvidenceHash == e.evidenceHash || otherEvidenceHash == bytes32(0)) revert NotEquivocation();
        if (!_validReceipt(id, otherEvidenceHash, payeeSig)) revert BadReceipt();
        e.state = State.Refunded;
        e.reason = Reason.Equivocation;
        usdc.safeTransfer(e.payer, e.amount);
        emit Equivocated(id, e.evidenceHash, otherEvidenceHash);
    }

    // ---- settlement ----------------------------------------------------------

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
            e.reason = Reason.VerdictYes;
            usdc.safeTransfer(e.payee, e.amount);
        } else if (outcome == oracle.NO()) {
            e.state = State.Refunded;
            e.reason = Reason.VerdictNo;
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
            e.reason = Reason.ArbiterRelease;
            usdc.safeTransfer(e.payee, e.amount);
        } else {
            e.state = State.Refunded;
            e.reason = Reason.ArbiterRefund;
            usdc.safeTransfer(e.payer, e.amount);
        }
        emit Arbitrated(id, release, msg.sender);
    }

    /// @notice After the deadline with no accepted verdict, anyone may return the funds to the payer.
    function refundAfterDeadline(bytes32 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.state != State.Open && e.state != State.Escalated) revert NotOpen();
        if (block.timestamp <= e.deadline) revert DeadlineNotPassed();
        e.state = State.Refunded;
        e.reason = Reason.DeadlineRefund;
        usdc.safeTransfer(e.payer, e.amount);
        emit RefundedAfterDeadline(id);
    }

    function get(bytes32 id) external view returns (Escrow memory) {
        return escrows[id];
    }

    // ---- internal ------------------------------------------------------------

    function _checkPolicy(CountersignOracle.Policy calldata policy) private pure {
        if (policy.judges == 0 || policy.minAgree == 0 || policy.minAgree > policy.judges || policy.minConfBps > 10000) {
            revert BadPolicy();
        }
    }

    function _store(
        bytes32 id,
        address payer,
        address payee,
        address arbiter,
        uint96 amount,
        uint64 deadline,
        bytes32 rubricHash,
        CountersignOracle.Policy calldata policy,
        uint256 agentId
    ) private {
        escrows[id] = Escrow({
            payer: payer,
            payee: payee,
            arbiter: arbiter,
            amount: amount,
            deadline: deadline,
            rubricHash: rubricHash,
            evidenceHash: bytes32(0),
            policy: policy,
            state: State.Open,
            reason: Reason.None,
            agentId: agentId
        });
    }

    function _setEvidence(bytes32 id, bytes32 evidenceHash, string calldata storageRef) private {
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert NotOpen();
        if (e.evidenceHash != bytes32(0)) revert EvidenceAlreadySet();
        if (block.timestamp > e.deadline) revert DeadlinePassed();
        if (evidenceHash == bytes32(0)) revert EvidenceMissing();
        e.evidenceHash = evidenceHash;
        emit EvidenceSet(id, evidenceHash, storageRef);
    }

    function _validReceipt(bytes32 id, bytes32 evidenceHash, bytes calldata sig) private view returns (bool) {
        address payee = escrows[id].payee;
        return payee != address(0) && SignatureChecker.isValidSignatureNow(payee, receiptDigest(id, evidenceHash), sig);
    }
}
