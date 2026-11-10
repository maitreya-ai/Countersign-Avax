// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SignerRegistry} from "../src/SignerRegistry.sol";
import {CountersignOracle} from "../src/CountersignOracle.sol";
import {CountersignEscrow} from "../src/CountersignEscrow.sol";
import {CountersignValidator} from "../src/CountersignValidator.sol";
import {IIdentityRegistry, IValidationRegistry} from "../src/interfaces/IERC8004.sol";
import {JudgeBase} from "./utils/JudgeBase.sol";
import {MockUSDC3009, MockIdentityRegistry, MockValidationRegistry} from "./utils/Mocks.sol";

contract ValidatorTest is JudgeBase {
    SignerRegistry registry;
    CountersignOracle oracle;
    CountersignEscrow escrow;
    MockUSDC3009 usdc;
    MockIdentityRegistry identity;
    MockValidationRegistry validation;
    CountersignValidator validator;

    uint256 constant AGENT_PK = 0xA6E27;
    uint256 constant SELLER_PK = 0x5E11E8;
    address agent;
    address seller;
    uint256 sellerAgentId;
    uint96 constant AMOUNT = 250_000;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new SignerRegistry(address(this));
        oracle = new CountersignOracle(registry);
        usdc = new MockUSDC3009();
        escrow = new CountersignEscrow(IERC20(address(usdc)), oracle);
        identity = new MockIdentityRegistry();
        validation = new MockValidationRegistry(address(identity));
        validator = new CountersignValidator(
            IValidationRegistry(address(validation)), IIdentityRegistry(address(identity)), escrow, "https://node.test/escrows/", address(this)
        );
        registerJudges(registry);
        agent = vm.addr(AGENT_PK);
        seller = vm.addr(SELLER_PK);
        usdc.mint(agent, 100e6);

        vm.startPrank(seller);
        sellerAgentId = identity.register("https://seller.test/agent.json");
        identity.approve(address(validator), sellerAgentId); // opt in: anyone can record every judged sale
        vm.stopPrank();
    }

    // ---- helpers -------------------------------------------------------------

    function judged(bytes32 salt, string memory vA, string memory vB, uint256 agentId) internal returns (bytes32 id) {
        (CountersignEscrow.OpenAuth memory a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, agentId, salt);
        id = escrow.openWithAuthorization(a, RUBRIC, pol());
        bytes32 h = keccak256(bytes(EVIDENCE));
        escrow.setEvidenceWithReceipt(id, h, "x", signReceipt(SELLER_PK, escrow, id, h));
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) =
            bundle(keccak256(bytes(RUBRIC)), h, vA, vB, "Y", "0.95");
        escrow.settle(id, j, g, c, ids());
    }

    function summary() internal view returns (uint64 count, uint8 avg) {
        address[] memory vs = new address[](1);
        vs[0] = address(validator);
        return validation.getSummary(sellerAgentId, vs, "countersign");
    }

    // ---- scores ---------------------------------------------------------------

    function test_Yes_Records100() public {
        bytes32 id = judged(bytes32("1"), "Y", "Y", sellerAgentId);
        vm.prank(address(0x777)); // anyone
        assertEq(validator.record(id), 100);
        (uint64 n, uint8 avg) = summary();
        assertEq(n, 1);
        assertEq(avg, 100);
        (address v, uint256 a, uint8 resp,, string memory tag,) =
            validation.getValidationStatus(validator.requestHashFor(id, sellerAgentId));
        assertEq(v, address(validator));
        assertEq(a, sellerAgentId);
        assertEq(resp, 100);
        assertEq(tag, "countersign");
    }

    function test_No_Records0() public {
        bytes32 id = judged(bytes32("1"), "N", "N", sellerAgentId);
        assertEq(validator.record(id), 0);
        (uint64 n, uint8 avg) = summary();
        assertEq(n, 1);
        assertEq(avg, 0);
    }

    function test_Equivocation_Records0() public {
        (CountersignEscrow.OpenAuth memory a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, sellerAgentId, "e");
        bytes32 id = escrow.openWithAuthorization(a, RUBRIC, pol());
        bytes32 h = keccak256(bytes(EVIDENCE));
        escrow.setEvidenceWithReceipt(id, h, "x", signReceipt(SELLER_PK, escrow, id, h));
        bytes32 served = keccak256("served");
        escrow.proveEquivocation(id, served, signReceipt(SELLER_PK, escrow, id, served));
        assertEq(validator.record(id), 0);
    }

    function test_MixedHistory_Average() public {
        validator.record(judged(bytes32("1"), "Y", "Y", sellerAgentId));
        validator.record(judged(bytes32("2"), "Y", "Y", sellerAgentId));
        validator.record(judged(bytes32("3"), "N", "N", sellerAgentId));
        (uint64 n, uint8 avg) = summary();
        assertEq(n, 3);
        assertEq(avg, 66);
    }

    // ---- what is never recorded ------------------------------------------------

    function test_RevertWhen_Escalated() public {
        bytes32 id = judged(bytes32("1"), "Y", "N", sellerAgentId);
        vm.expectRevert(CountersignValidator.NotJudged.selector);
        validator.record(id);
    }

    function test_RevertWhen_Open() public {
        (CountersignEscrow.OpenAuth memory a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, sellerAgentId, "o");
        bytes32 id = escrow.openWithAuthorization(a, RUBRIC, pol());
        vm.expectRevert(CountersignValidator.NotJudged.selector);
        validator.record(id);
    }

    function test_RevertWhen_DeadlineRefund() public {
        (CountersignEscrow.OpenAuth memory a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, sellerAgentId, "d");
        bytes32 id = escrow.openWithAuthorization(a, RUBRIC, pol());
        vm.warp(block.timestamp + 1 hours);
        escrow.refundAfterDeadline(id);
        vm.expectRevert(CountersignValidator.NotJudged.selector);
        validator.record(id);
    }

    function test_RevertWhen_ArbiterDecision() public {
        address arb = address(0xAB);
        vm.prank(agent);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(agent);
        bytes32 id = escrow.open(seller, arb, AMOUNT, uint64(block.timestamp + 1 days), RUBRIC, pol());
        vm.prank(seller);
        escrow.setEvidence(id, keccak256(bytes(EVIDENCE)), "x");
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) =
            bundle(keccak256(bytes(RUBRIC)), keccak256(bytes(EVIDENCE)), "Y", "N", "Y", "0.95");
        escrow.settle(id, j, g, c, ids());
        vm.prank(arb);
        escrow.arbitrate(id, true);
        // v1 open has no agent id; and arbiter outcomes are never scored
        vm.expectRevert(CountersignValidator.NoAgent.selector);
        validator.record(id);
        (bool isJudged,) = validator.scoreOf(CountersignEscrow.Reason.ArbiterRelease);
        assertFalse(isJudged);
        (isJudged,) = validator.scoreOf(CountersignEscrow.Reason.ArbiterRefund);
        assertFalse(isJudged);
    }

    function test_RevertWhen_RecordedTwice() public {
        bytes32 id = judged(bytes32("1"), "Y", "Y", sellerAgentId);
        validator.record(id);
        vm.expectRevert(CountersignValidator.AlreadyRecorded.selector);
        validator.record(id);
    }

    // ---- credit cannot be stolen or misdirected ---------------------------------

    function test_RevertWhen_AgentNotOwnedByPayee() public {
        // a seller advertises someone else's (good) agent id
        vm.prank(address(0x0DD));
        uint256 victimId = identity.register("victim");
        bytes32 id = judged(bytes32("1"), "N", "N", victimId);
        vm.expectRevert(abi.encodeWithSelector(CountersignValidator.AgentNotPayee.selector, victimId, address(0x0DD), seller));
        validator.record(id);
    }

    function test_RevertWhen_SellerDidNotOptIn_AndFiledNothing() public {
        vm.prank(seller);
        identity.approve(address(0), sellerAgentId);
        assertFalse(validator.canSelfFile(sellerAgentId));
        bytes32 id = judged(bytes32("1"), "N", "N", sellerAgentId);
        vm.expectRevert(bytes("Not authorized"));
        validator.record(id);
    }

    function test_SellerFiledRequest_WorksWithoutApproval() public {
        vm.prank(seller);
        identity.approve(address(0), sellerAgentId);
        bytes32 id = judged(bytes32("1"), "Y", "Y", sellerAgentId);
        bytes32 rh = validator.requestHashFor(id, sellerAgentId);
        vm.prank(seller);
        validation.validationRequest(address(validator), sellerAgentId, "u", rh);
        assertEq(validator.record(id), 100);
    }

    function test_RevertWhen_RequestNamesOtherValidator() public {
        bytes32 id = judged(bytes32("1"), "N", "N", sellerAgentId);
        bytes32 rh = validator.requestHashFor(id, sellerAgentId);
        vm.prank(seller); // the seller squats its own slot with a validator that will never answer
        validation.validationRequest(address(0xDEAD), sellerAgentId, "u", rh);
        vm.expectRevert(abi.encodeWithSelector(CountersignValidator.RequestMismatch.selector, address(0xDEAD), sellerAgentId));
        validator.record(id);
    }

    function test_ApprovalForAllAlsoWorks() public {
        vm.startPrank(seller);
        identity.approve(address(0), sellerAgentId);
        identity.setApprovalForAll(address(validator), true);
        vm.stopPrank();
        assertTrue(validator.canSelfFile(sellerAgentId));
        assertEq(validator.record(judged(bytes32("1"), "Y", "Y", sellerAgentId)), 100);
    }

    function test_UriAndOwnerOnlyBaseURI() public {
        bytes32 id = bytes32(uint256(0xabc));
        assertEq(validator.uriFor(id), "https://node.test/escrows/0x0000000000000000000000000000000000000000000000000000000000000abc");
        vm.prank(address(0xBAD));
        vm.expectRevert();
        validator.setBaseURI("https://evil/");
        validator.setBaseURI("https://node2.test/escrows/");
        assertEq(validator.baseURI(), "https://node2.test/escrows/");
    }
}
