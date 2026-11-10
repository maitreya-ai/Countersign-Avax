// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {AssayEscrow} from "./AssayEscrow.sol";
import {IIdentityRegistry, IValidationRegistry} from "./interfaces/IERC8004.sol";

/// @title AssayValidator
/// @notice Turns judged escrows into ERC-8004 validation records for the seller's agent identity.
///         It never re-checks the verdict bundle (AssayEscrow already did); it reads the escrow's
///         final `reason`, which needs no trust.
///
///         Scores: VerdictYes -> 100. VerdictNo or Equivocation -> 0. Arbiter decisions, deadline
///         refunds and escalations are not machine-verified, so they are never recorded.
///
///         The agent id comes from the escrow itself (the buyer signed it into the terms), so the
///         caller cannot choose where a record lands, and each escrow is recorded at most once.
///
///         Filing: ERC-8004 lets only the agent's owner or an approved operator file a validation
///         request. A seller that approves this contract (`approve(validator, agentId)` or
///         `setApprovalForAll`) lets anyone record every judged sale, good or bad, with one call;
///         it can no longer hide its failures by not filing. Buyers check that approval before
///         trusting a seller's record (see `canSelfFile`). Without the approval, `record` only works
///         if the seller filed the request itself.
contract AssayValidator is Ownable {
    string public constant TAG = "assay";
    bytes32 public constant VALIDATION_TAG = keccak256("assay.validation.v1");

    IValidationRegistry public immutable validation;
    IIdentityRegistry public immutable identity;
    AssayEscrow public immutable escrow;

    /// @notice Prefix of the request/response URI, e.g. "https://node.example/escrows/"
    string public baseURI;

    mapping(bytes32 escrowId => bool) public recorded;

    event Recorded(bytes32 indexed escrowId, uint256 indexed agentId, uint8 score, bytes32 requestHash, bool selfFiled);
    event BaseURISet(string baseURI);

    error AlreadyRecorded();
    error NoAgent();
    error NotJudged();
    error AgentNotPayee(uint256 agentId, address owner, address payee);
    error RequestMismatch(address validator, uint256 agentId);

    constructor(IValidationRegistry validation_, IIdentityRegistry identity_, AssayEscrow escrow_, string memory baseURI_, address owner_)
        Ownable(owner_)
    {
        validation = validation_;
        identity = identity_;
        escrow = escrow_;
        baseURI = baseURI_;
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        baseURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    /// @notice Per-agent request hash, so no one can squat on a shared slot.
    function requestHashFor(bytes32 escrowId, uint256 agentId) public pure returns (bytes32) {
        return keccak256(abi.encode(VALIDATION_TAG, escrowId, agentId));
    }

    /// @notice Score for a final reason; `judged` is false for outcomes that are never recorded.
    function scoreOf(AssayEscrow.Reason reason) public pure returns (bool judged, uint8 score) {
        if (reason == AssayEscrow.Reason.VerdictYes) return (true, 100);
        if (reason == AssayEscrow.Reason.VerdictNo || reason == AssayEscrow.Reason.Equivocation) return (true, 0);
        return (false, 0);
    }

    /// @notice True when the seller has let this contract file requests for `agentId` itself.
    function canSelfFile(uint256 agentId) public view returns (bool) {
        address owner_ = identity.ownerOf(agentId);
        return identity.getApproved(agentId) == address(this) || identity.isApprovedForAll(owner_, address(this));
    }

    function uriFor(bytes32 escrowId) public view returns (string memory) {
        return string.concat(baseURI, Strings.toHexString(uint256(escrowId), 32));
    }

    /// @notice Record a final, judged escrow in the seller's ERC-8004 validation history. Anyone may call.
    function record(bytes32 escrowId) external returns (uint8 score) {
        if (recorded[escrowId]) revert AlreadyRecorded();
        AssayEscrow.Escrow memory e = escrow.get(escrowId);
        if (e.agentId == escrow.NO_AGENT()) revert NoAgent();
        (bool judged, uint8 s) = scoreOf(e.reason);
        if (!judged) revert NotJudged();
        address agentOwner = identity.ownerOf(e.agentId);
        if (agentOwner != e.payee) revert AgentNotPayee(e.agentId, agentOwner, e.payee);

        bytes32 rh = requestHashFor(escrowId, e.agentId);
        string memory uri = uriFor(escrowId);
        bool selfFiled;
        try validation.getValidationStatus(rh) returns (address v, uint256 a, uint8, bytes32, string memory, uint256) {
            if (v != address(this) || a != e.agentId) revert RequestMismatch(v, a);
        } catch {
            // no request yet: file it ourselves (reverts "Not authorized" unless the seller approved us)
            validation.validationRequest(address(this), e.agentId, uri, rh);
            selfFiled = true;
        }

        recorded[escrowId] = true;
        score = s;
        validation.validationResponse(rh, s, uri, keccak256(abi.encode(escrowId, e.reason, e.rubricHash, e.evidenceHash)), TAG);
        emit Recorded(escrowId, e.agentId, s, rh, selfFiled);
    }
}
