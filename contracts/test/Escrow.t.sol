// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SignerRegistry} from "../src/SignerRegistry.sol";
import {CountersignOracle} from "../src/CountersignOracle.sol";
import {CountersignEscrow} from "../src/CountersignEscrow.sol";
import {JudgeBase} from "./utils/JudgeBase.sol";
import {MockUSDC3009, Mock1271Wallet} from "./utils/Mocks.sol";

contract EscrowTest is JudgeBase {
    SignerRegistry registry;
    CountersignOracle oracle;
    CountersignEscrow escrow;
    MockUSDC3009 usdc;

    uint256 constant AGENT_PK = 0xA6E27;   // buyer
    uint256 constant SELLER_PK = 0x5E11E8; // seller
    address agent;
    address seller;
    uint256 constant AGENT_ID = 1042;
    uint96 constant AMOUNT = 250_000; // 0.25 USDC

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new SignerRegistry(address(this));
        oracle = new CountersignOracle(registry);
        usdc = new MockUSDC3009();
        escrow = new CountersignEscrow(IERC20(address(usdc)), oracle);
        registerJudges(registry);
        agent = vm.addr(AGENT_PK);
        seller = vm.addr(SELLER_PK);
        usdc.mint(agent, 100e6);
    }

    // ---- helpers -------------------------------------------------------------

    function openAuth(bytes32 salt) internal returns (bytes32 id, bytes32 nonce_) {
        (CountersignEscrow.OpenAuth memory a, bytes32 n) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, AGENT_ID, salt);
        id = escrow.openWithAuthorization(a, RUBRIC, pol());
        nonce_ = n;
    }

    function withEvidence(bytes32 salt) internal returns (bytes32 id) {
        (id,) = openAuth(salt);
        bytes32 h = keccak256(bytes(EVIDENCE));
        escrow.setEvidenceWithReceipt(id, h, "node://e", signReceipt(SELLER_PK, escrow, id, h));
    }

    function settleWith(bytes32 id, string memory vA, string memory vB) internal {
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) =
            bundle(keccak256(bytes(RUBRIC)), keccak256(bytes(EVIDENCE)), vA, vB, "Y", "0.95");
        escrow.settle(id, j, g, c, ids());
    }

    function reasonOf(bytes32 id) internal view returns (CountersignEscrow.Reason) {
        return escrow.get(id).reason;
    }

    // ---- openWithAuthorization ----------------------------------------------

    function test_OpenWithAuthorization_LocksExactTerms() public {
        address submitter = address(0x5AB);
        (CountersignEscrow.OpenAuth memory a, bytes32 n) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, AGENT_ID, bytes32("s1"));
        vm.prank(submitter); // anyone may submit; the agent pays no gas
        bytes32 id = escrow.openWithAuthorization(a, RUBRIC, pol());

        assertEq(id, escrow.escrowIdFor(agent, n));
        CountersignEscrow.Escrow memory e = escrow.get(id);
        assertEq(e.payer, agent);
        assertEq(e.payee, seller);
        assertEq(e.amount, AMOUNT);
        assertEq(e.agentId, AGENT_ID);
        assertEq(e.rubricHash, keccak256(bytes(RUBRIC)));
        assertEq(uint8(e.state), uint8(CountersignEscrow.State.Open));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(agent), 100e6 - AMOUNT);
        assertTrue(usdc.authorizationState(agent, n));
    }

    function cp(CountersignEscrow.OpenAuth memory a) internal pure returns (CountersignEscrow.OpenAuth memory b) {
        b = CountersignEscrow.OpenAuth(a.payer, a.payee, a.arbiter, a.amount, a.deadline, a.agentId, a.salt, a.validAfter, a.validBefore, a.v, a.r, a.s);
    }

    function _expectTermsRevert(CountersignEscrow.OpenAuth memory a, string memory rubric, CountersignOracle.Policy memory p) internal {
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        escrow.openWithAuthorization(a, rubric, p);
    }

    function test_RevertWhen_AnyTermChanged() public {
        (CountersignEscrow.OpenAuth memory a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, AGENT_ID, bytes32("s1"));
        CountersignEscrow.OpenAuth memory m;

        m = cp(a); m.amount = AMOUNT + 1; _expectTermsRevert(m, RUBRIC, pol());
        m = cp(a); m.payee = address(0xBAD); _expectTermsRevert(m, RUBRIC, pol());
        m = cp(a); m.arbiter = address(0xBAD); _expectTermsRevert(m, RUBRIC, pol());
        m = cp(a); m.deadline = a.deadline + 1; _expectTermsRevert(m, RUBRIC, pol());
        m = cp(a); m.agentId = AGENT_ID + 1; _expectTermsRevert(m, RUBRIC, pol());
        m = cp(a); m.salt = bytes32("s2"); _expectTermsRevert(m, RUBRIC, pol());
        _expectTermsRevert(a, "Exactly 3 bullets.", pol());
        CountersignOracle.Policy memory p = pol(); p.minConfBps = 5000;
        _expectTermsRevert(a, RUBRIC, p);

        // the untouched authorisation still works afterwards
        escrow.openWithAuthorization(a, RUBRIC, pol());
    }

    function test_RevertWhen_AuthorizationReplayed() public {
        (CountersignEscrow.OpenAuth memory a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, AGENT_ID, bytes32("s1"));
        escrow.openWithAuthorization(a, RUBRIC, pol());
        vm.expectRevert(CountersignEscrow.IdInUse.selector);
        escrow.openWithAuthorization(a, RUBRIC, pol());
    }

    function test_RevertWhen_AuthorizationExpired() public {
        (CountersignEscrow.OpenAuth memory a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, AGENT_ID, bytes32("s1"));
        vm.warp(block.timestamp + 3 minutes);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        escrow.openWithAuthorization(a, RUBRIC, pol());
    }

    function test_FrontRunnerCannotRedeemAuthorization() public {
        (CountersignEscrow.OpenAuth memory a, bytes32 n) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, AGENT_ID, bytes32("s1"));
        // someone copies the signature from the mempool and calls USDC directly
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(agent, address(escrow), AMOUNT, a.validAfter, a.validBefore, n, a.v, a.r, a.s);
    }

    function test_RevertWhen_ZeroAmountOrPastDeadline() public {
        (CountersignEscrow.OpenAuth memory a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, 0, AGENT_ID, bytes32("s1"));
        vm.expectRevert(CountersignEscrow.BadTerms.selector);
        escrow.openWithAuthorization(a, RUBRIC, pol());
        (a,) = buildAuth(escrow, address(usdc), AGENT_PK, seller, AMOUNT, AGENT_ID, bytes32("s1"));
        a.deadline = uint64(block.timestamp);
        vm.expectRevert(CountersignEscrow.DeadlinePassed.selector);
        escrow.openWithAuthorization(a, RUBRIC, pol());
    }

    function test_TermsHashBindsChainAndContract() public {
        bytes32 h1 = escrow.termsHash(seller, address(0), AMOUNT, 100, bytes32(0), pol(), AGENT_ID, bytes32(0));
        CountersignEscrow other = new CountersignEscrow(IERC20(address(usdc)), oracle);
        assertTrue(h1 != other.termsHash(seller, address(0), AMOUNT, 100, bytes32(0), pol(), AGENT_ID, bytes32(0)));
        vm.chainId(43114);
        assertTrue(h1 != escrow.termsHash(seller, address(0), AMOUNT, 100, bytes32(0), pol(), AGENT_ID, bytes32(0)));
    }

    // ---- receipts and evidence ------------------------------------------------

    function test_EvidenceWithReceipt_AnyoneCanSubmit() public {
        (bytes32 id,) = openAuth(bytes32("s1"));
        bytes32 h = keccak256(bytes(EVIDENCE));
        bytes memory sig = signReceipt(SELLER_PK, escrow, id, h);
        vm.prank(agent); // the buyer posts it when the seller withholds it
        escrow.setEvidenceWithReceipt(id, h, "node://e", sig);
        assertEq(escrow.get(id).evidenceHash, h);
    }

    function test_RevertWhen_ReceiptFromWrongSigner() public {
        (bytes32 id,) = openAuth(bytes32("s1"));
        bytes32 h = keccak256(bytes(EVIDENCE));
        bytes memory sig = signReceipt(AGENT_PK, escrow, id, h);
        vm.expectRevert(CountersignEscrow.BadReceipt.selector);
        escrow.setEvidenceWithReceipt(id, h, "node://e", sig);
    }

    function test_RevertWhen_ReceiptForOtherEscrow() public {
        (bytes32 id1,) = openAuth(bytes32("s1"));
        (bytes32 id2,) = openAuth(bytes32("s2"));
        bytes32 h = keccak256(bytes(EVIDENCE));
        bytes memory sig = signReceipt(SELLER_PK, escrow, id1, h);
        vm.expectRevert(CountersignEscrow.BadReceipt.selector);
        escrow.setEvidenceWithReceipt(id2, h, "node://e", sig);
    }

    function test_RevertWhen_SecondEvidence() public {
        bytes32 id = withEvidence(bytes32("s1"));
        bytes32 h2 = keccak256("other");
        bytes memory sig = signReceipt(SELLER_PK, escrow, id, h2);
        vm.expectRevert(CountersignEscrow.EvidenceAlreadySet.selector);
        escrow.setEvidenceWithReceipt(id, h2, "node://e", sig);
        vm.prank(seller);
        vm.expectRevert(CountersignEscrow.EvidenceAlreadySet.selector);
        escrow.setEvidence(id, h2, "node://e");
    }

    function test_RevertWhen_EvidenceAfterDeadline() public {
        (bytes32 id,) = openAuth(bytes32("s1"));
        bytes32 h = keccak256(bytes(EVIDENCE));
        bytes memory sig = signReceipt(SELLER_PK, escrow, id, h);
        vm.warp(block.timestamp + 16 minutes);
        vm.expectRevert(CountersignEscrow.DeadlinePassed.selector);
        escrow.setEvidenceWithReceipt(id, h, "node://e", sig);
    }

    function test_Receipt_ERC1271SellerWallet() public {
        Mock1271Wallet wallet = new Mock1271Wallet(seller);
        (CountersignEscrow.OpenAuth memory a,) =
            buildAuth(escrow, address(usdc), AGENT_PK, address(wallet), AMOUNT, AGENT_ID, bytes32("s1"));
        bytes32 id = escrow.openWithAuthorization(a, RUBRIC, pol());
        bytes32 h = keccak256(bytes(EVIDENCE));
        escrow.setEvidenceWithReceipt(id, h, "node://e", signReceipt(SELLER_PK, escrow, id, h));
        assertEq(escrow.get(id).evidenceHash, h);
    }

    // ---- equivocation --------------------------------------------------------

    function test_Equivocation_RefundsBuyer() public {
        (bytes32 id,) = openAuth(bytes32("s1"));
        bytes32 served = keccak256("what the buyer received");
        bytes32 committed = keccak256(bytes(EVIDENCE));
        bytes memory servedSig = signReceipt(SELLER_PK, escrow, id, served); // the receipt the buyer holds
        escrow.setEvidenceWithReceipt(id, committed, "node://e", signReceipt(SELLER_PK, escrow, id, committed));

        uint256 before = usdc.balanceOf(agent);
        vm.prank(address(0x4EE)); // anyone holding the receipt can prove it
        escrow.proveEquivocation(id, served, servedSig);

        assertEq(usdc.balanceOf(agent), before + AMOUNT);
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Refunded));
        assertEq(uint8(reasonOf(id)), uint8(CountersignEscrow.Reason.Equivocation));
    }

    function test_Equivocation_SameHashIsNotProof() public {
        bytes32 id = withEvidence(bytes32("s1"));
        bytes32 h = keccak256(bytes(EVIDENCE));
        bytes memory sig = signReceipt(SELLER_PK, escrow, id, h);
        vm.expectRevert(CountersignEscrow.NotEquivocation.selector);
        escrow.proveEquivocation(id, h, sig);
    }

    function test_Equivocation_NeedsPayeeSignature() public {
        bytes32 id = withEvidence(bytes32("s1"));
        bytes32 other = keccak256("x");
        bytes memory sig = signReceipt(AGENT_PK, escrow, id, other);
        vm.expectRevert(CountersignEscrow.BadReceipt.selector);
        escrow.proveEquivocation(id, other, sig);
    }

    function test_Equivocation_NeedsCommittedEvidence() public {
        (bytes32 id,) = openAuth(bytes32("s1"));
        bytes32 other = keccak256("x");
        bytes memory sig = signReceipt(SELLER_PK, escrow, id, other);
        vm.expectRevert(CountersignEscrow.EvidenceMissing.selector);
        escrow.proveEquivocation(id, other, sig);
    }

    function test_Equivocation_WorksWhileEscalated() public {
        bytes32 id = withEvidence(bytes32("s1"));
        settleWith(id, "Y", "N"); // judges disagree -> ESCALATE
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Escalated));
        bytes32 other = keccak256("x");
        escrow.proveEquivocation(id, other, signReceipt(SELLER_PK, escrow, id, other));
        assertEq(uint8(reasonOf(id)), uint8(CountersignEscrow.Reason.Equivocation));
    }

    function test_Equivocation_NotAfterFinal() public {
        bytes32 id = withEvidence(bytes32("s1"));
        settleWith(id, "Y", "Y");
        bytes32 other = keccak256("x");
        bytes memory sig = signReceipt(SELLER_PK, escrow, id, other);
        vm.expectRevert(CountersignEscrow.NotOpen.selector);
        escrow.proveEquivocation(id, other, sig);
    }

    // ---- outcomes and reasons -------------------------------------------------

    function test_Yes_PaysSeller_ReasonVerdictYes() public {
        bytes32 id = withEvidence(bytes32("s1"));
        settleWith(id, "Y", "Y");
        assertEq(usdc.balanceOf(seller), AMOUNT);
        assertEq(uint8(reasonOf(id)), uint8(CountersignEscrow.Reason.VerdictYes));
    }

    function test_No_RefundsBuyer_ReasonVerdictNo() public {
        bytes32 id = withEvidence(bytes32("s1"));
        uint256 before = usdc.balanceOf(agent);
        settleWith(id, "N", "N");
        assertEq(usdc.balanceOf(agent), before + AMOUNT);
        assertEq(uint8(reasonOf(id)), uint8(CountersignEscrow.Reason.VerdictNo));
    }

    function test_Escalate_ReasonNone() public {
        bytes32 id = withEvidence(bytes32("s1"));
        settleWith(id, "Y", "N");
        assertEq(uint8(reasonOf(id)), uint8(CountersignEscrow.Reason.None));
    }

    function test_ArbiterReasons() public {
        address arb = address(0xAB);
        vm.startPrank(agent);
        usdc.approve(address(escrow), type(uint256).max);
        bytes32 id1 = escrow.open(seller, arb, AMOUNT, uint64(block.timestamp + 1 days), RUBRIC, pol());
        bytes32 id2 = escrow.open(seller, arb, AMOUNT, uint64(block.timestamp + 1 days), RUBRIC, pol());
        vm.stopPrank();
        vm.startPrank(seller);
        escrow.setEvidence(id1, keccak256(bytes(EVIDENCE)), "x");
        escrow.setEvidence(id2, keccak256(bytes(EVIDENCE)), "x");
        vm.stopPrank();
        settleWith(id1, "Y", "N");
        settleWith(id2, "Y", "N");
        vm.startPrank(arb);
        escrow.arbitrate(id1, true);
        escrow.arbitrate(id2, false);
        vm.stopPrank();
        assertEq(uint8(reasonOf(id1)), uint8(CountersignEscrow.Reason.ArbiterRelease));
        assertEq(uint8(reasonOf(id2)), uint8(CountersignEscrow.Reason.ArbiterRefund));
        assertEq(escrow.get(id1).agentId, escrow.NO_AGENT());
    }

    function test_DeadlineRefund_AnyoneTriggers_PaysOnlyPayer() public {
        (bytes32 id,) = openAuth(bytes32("s1"));
        vm.expectRevert(CountersignEscrow.DeadlineNotPassed.selector);
        escrow.refundAfterDeadline(id);
        vm.warp(block.timestamp + 16 minutes);
        uint256 before = usdc.balanceOf(agent);
        vm.prank(address(0xCAFE));
        escrow.refundAfterDeadline(id);
        assertEq(usdc.balanceOf(agent), before + AMOUNT);
        assertEq(usdc.balanceOf(address(0xCAFE)), 0);
        assertEq(uint8(reasonOf(id)), uint8(CountersignEscrow.Reason.DeadlineRefund));
    }

    // ---- invariants: funds move once, final states are final ---------------------

    function test_FinalStatesAreFinal() public {
        bytes32 id = withEvidence(bytes32("s1"));
        settleWith(id, "Y", "Y");
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) =
            bundle(keccak256(bytes(RUBRIC)), keccak256(bytes(EVIDENCE)), "N", "N", "Y", "0.95");
        vm.expectRevert(CountersignEscrow.NotOpen.selector);
        escrow.settle(id, j, g, c, ids());
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(CountersignEscrow.NotOpen.selector);
        escrow.refundAfterDeadline(id);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(seller), AMOUNT);
    }

    function test_EscrowBalanceEqualsOpenAmounts() public {
        bytes32 a = withEvidence(bytes32("a"));
        bytes32 b = withEvidence(bytes32("b"));
        withEvidence(bytes32("c"));
        assertEq(usdc.balanceOf(address(escrow)), 3 * uint256(AMOUNT));
        settleWith(a, "Y", "Y");
        settleWith(b, "N", "N");
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(seller) + usdc.balanceOf(agent) + usdc.balanceOf(address(escrow)), 100e6);
    }
}
