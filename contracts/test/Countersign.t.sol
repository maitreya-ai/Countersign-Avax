// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignerRegistry} from "../src/SignerRegistry.sol";
import {CountersignOracle} from "../src/CountersignOracle.sol";
import {CountersignEscrow} from "../src/CountersignEscrow.sol";

/// Test-only ERC-20 standing in for Arc USDC (6 decimals). Production uses the real token.
contract TestUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract VerdictTest is Test {
    SignerRegistry registry;
    CountersignOracle oracle;
    CountersignEscrow escrow;
    TestUSDC usdc;

    // Enclave signer keys. In production these are the providers' TEE signing keys
    // published in 0G InferenceServing.getService(provider).teeSignerAddress.
    uint256 constant PK_A = 0xA11CE;
    uint256 constant PK_B = 0xB0B;
    uint256 constant PK_G = 0xC0FFEE;
    uint256 constant PK_C = 0xD00D;
    address provA = address(0x1A);
    address provB = address(0x1B);
    address provG = address(0x1C);
    address provC = address(0x1D);

    address payer = address(0xFA);
    address payee = address(0xFE);
    address arbiter = address(0xAB);

    string constant RUBRIC = "Deliver a Next.js landing page: [lighthouse] score 90+, [deployed] URL, [repo] link.";
    string constant EVIDENCE = "repo: github.com/x/y; deployed: https://y.vercel.app; lighthouse: 94 performance";

    CountersignOracle.Policy pol = CountersignOracle.Policy({judges: 2, minAgree: 2, minConfBps: 8500, requireGrounded: true});

    function setUp() public {
        registry = new SignerRegistry(address(this));
        oracle = new CountersignOracle(registry);
        usdc = new TestUSDC();
        escrow = new CountersignEscrow(IERC20(usdc), oracle);

        registry.sync(provA, vm.addr(PK_A), "glm-5.3", 1, bytes32(0));
        registry.sync(provB, vm.addr(PK_B), "0GM-1.0-35B-A3B", 1, bytes32(0));
        registry.sync(provG, vm.addr(PK_G), "0GM-1.0-35B-A3B-SIA", 1, bytes32(0));
        registry.sync(provC, vm.addr(PK_C), "glm-5.3-cal", 1, bytes32(0));

        usdc.mint(payer, 1_000e6);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ---- helpers -----------------------------------------------------------

    function hx(bytes32 v) internal pure returns (string memory) {
        return Strings.toHexString(uint256(v), 32); // "0x" + 64 lowercase hex
    }

    function header(string memory v, string memory conf, bytes32 r, bytes32 e) internal pure returns (string memory) {
        return string.concat("VERDICT:", v, ";CONF:", conf, ";RUBRIC:", hx(r), ";EVID:", hx(e), ";");
    }

    /// Request body as the relayer sends it: the system prompt names both escrow hashes.
    function reqBody(bytes32 r, bytes32 e) internal pure returns (bytes memory) {
        return bytes(string.concat(
            '{"model":"glm-5.3","temperature":0,"messages":[{"role":"system","content":"Settlement judge. RUBRIC:',
            hx(r), " EVID:", hx(e), '"},{"role":"user","content":"...evidence..."}]}'
        ));
    }

    /// Response body as the provider returns it: OpenAI JSON with the header inside content.
    function respBody(string memory content) internal pure returns (bytes memory) {
        return bytes(string.concat(
            '{"id":"chatcmpl-7f1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"',
            content, '"},"finish_reason":"stop"}],"usage":{"prompt_tokens":812,"completion_tokens":61}}'
        ));
    }

    /// hex(sha256(req)) ":" hex(sha256(resp)), lowercase, no 0x — what the broker signs
    function signedText(bytes memory req, bytes memory resp) internal pure returns (bytes memory) {
        string memory a = Strings.toHexString(uint256(sha256(req)), 32);
        string memory b = Strings.toHexString(uint256(sha256(resp)), 32);
        bytes memory ab = bytes(a);
        bytes memory bb = bytes(b);
        bytes memory out = new bytes(129);
        for (uint256 i = 0; i < 64; i++) { out[i] = ab[i + 2]; out[65 + i] = bb[i + 2]; }
        out[64] = ":";
        return out;
    }

    function attest(uint256 pk, address prov, bytes memory req, bytes memory resp)
        internal
        pure
        returns (CountersignOracle.Attested memory a)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(signedText(req, resp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        a = CountersignOracle.Attested({reqBody: req, respBody: resp, signature: abi.encodePacked(r, s, v), provider: prov});
    }

    function openEscrow() internal returns (bytes32 id) {
        vm.prank(payer);
        id = escrow.open(payee, arbiter, 50e6, uint64(block.timestamp + 7 days), RUBRIC, pol);
        vm.prank(payee);
        escrow.setEvidence(id, keccak256(bytes(EVIDENCE)), "0g://root");
    }

    function bundle(bytes32 r, bytes32 e, string memory vA, string memory vB, string memory g, string memory conf)
        internal
        pure
        returns (CountersignOracle.Attested[] memory judges, CountersignOracle.Attested memory grounding, CountersignOracle.Attested memory calibration)
    {
        bytes memory req = reqBody(r, e);
        judges = new CountersignOracle.Attested[](2);
        judges[0] = attest(PK_A, address(0x1A), req, respBody(string.concat(header(vA, "0.95", r, e), "All three items present.")));
        judges[1] = attest(PK_B, address(0x1B), req, respBody(string.concat(header(vB, "0.92", r, e), "Lighthouse 94, deployed URL and repo given.")));
        grounding = attest(PK_G, address(0x1C), req, respBody(string.concat(header(g, "0.99", r, e), "0 unsupported claims.")));
        calibration = attest(PK_C, address(0x1D), req, respBody(string.concat(header("Y", conf, r, e), "Judges agree.")));
    }

    function ids() internal pure returns (string[] memory s) {
        s = new string[](4);
        s[0] = "req-a"; s[1] = "req-b"; s[2] = "req-g"; s[3] = "req-c";
    }

    function hashes() internal pure returns (bytes32 r, bytes32 e) {
        return (keccak256(bytes(RUBRIC)), keccak256(bytes(EVIDENCE)));
    }

    // ---- tests -------------------------------------------------------------

    function test_SignedTextMatchesBrokerFormat() public view {
        bytes memory req = bytes('{"a":1}');
        bytes memory resp = bytes('{"b":2}');
        bytes memory got = oracle.signedText(req, resp);
        assertEq(got, signedText(req, resp));
        assertEq(got.length, 129);
        assertEq(got[64], bytes1(":"));
    }

    function test_ReleaseOnYes() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.95");
        escrow.settle(id, j, g, c, ids());
        assertEq(usdc.balanceOf(payee), 50e6);
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Resolved));
    }

    function test_RefundOnNo() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "N", "N", "Y", "0.90");
        uint256 before = usdc.balanceOf(payer);
        escrow.settle(id, j, g, c, ids());
        assertEq(usdc.balanceOf(payer), before + 50e6);
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Refunded));
    }

    function test_EscalateOnDisagreement_ThenArbitrate() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "N", "Y", "0.95");
        escrow.settle(id, j, g, c, ids());
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Escalated));
        assertEq(usdc.balanceOf(payee), 0);
        vm.prank(arbiter);
        escrow.arbitrate(id, true);
        assertEq(usdc.balanceOf(payee), 50e6);
    }

    function test_EscalateOnLowConfidence() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.52");
        escrow.settle(id, j, g, c, ids());
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Escalated));
    }

    function test_EscalateOnUngrounded() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "N", "0.95");
        escrow.settle(id, j, g, c, ids());
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Escalated));
    }

    function test_RevertTamperedResponse() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "N", "N", "Y", "0.95");
        // flip judge A's verdict inside the response body after signing: sha256 changes, signer no longer recovers
        bytes memory resp = j[0].respBody;
        for (uint256 i = 0; i + 8 < resp.length; i++) {
            if (resp[i] == "V" && resp[i + 7] == ":" && resp[i + 8] == "N") { resp[i + 8] = "Y"; break; }
        }
        j[0].respBody = resp;
        vm.expectRevert();
        escrow.settle(id, j, g, c, ids());
    }

    function test_RevertTamperedRequest() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.95");
        j[0].reqBody = bytes(string.concat(string(j[0].reqBody), " "));
        vm.expectRevert();
        escrow.settle(id, j, g, c, ids());
    }

    function test_RevertReplayFromAnotherEscrow() public {
        bytes32 id = openEscrow();
        (bytes32 r,) = hashes();
        bytes32 otherEvidence = keccak256("some other deliverable");
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, otherEvidence, "Y", "Y", "Y", "0.95");
        vm.expectRevert(abi.encodeWithSelector(CountersignOracle.RequestNotBound.selector, keccak256(bytes(EVIDENCE)), false));
        escrow.settle(id, j, g, c, ids());
    }

    function test_RevertHeaderForWrongEscrowEvenIfRequestMentionsBoth() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        bytes32 other = keccak256("other");
        // request names the right escrow, but the signed response carries a header for another evidence hash
        bytes memory req = bytes(string.concat(string(reqBody(r, e)), " ", hx(other)));
        CountersignOracle.Attested[] memory j = new CountersignOracle.Attested[](2);
        j[0] = attest(PK_A, provA, req, respBody(string.concat(header("Y", "0.95", r, other), "x")));
        j[1] = attest(PK_B, provB, req, respBody(string.concat(header("Y", "0.92", r, e), "x")));
        CountersignOracle.Attested memory g = attest(PK_G, provG, req, respBody(string.concat(header("Y", "0.99", r, e), "x")));
        CountersignOracle.Attested memory c = attest(PK_C, provC, req, respBody(string.concat(header("Y", "0.95", r, e), "x")));
        vm.expectRevert(abi.encodeWithSelector(CountersignOracle.WrongEscrow.selector, e, other, false));
        escrow.settle(id, j, g, c, ids());
    }

    function test_RevertUnregisteredSigner() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.95");
        j[0] = attest(0xBAD, provA, j[0].reqBody, j[0].respBody);
        vm.expectRevert(abi.encodeWithSelector(CountersignOracle.UnknownSigner.selector, vm.addr(0xBAD)));
        escrow.settle(id, j, g, c, ids());
    }

    function test_RevertSameModelTwice() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.95");
        j[1] = attest(PK_A, provA, j[1].reqBody, j[1].respBody);
        vm.expectRevert(abi.encodeWithSelector(CountersignOracle.SameModelTwice.selector, keccak256("glm-5.3")));
        escrow.settle(id, j, g, c, ids());
    }

    function test_RevertProviderMismatch() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.95");
        j[0].provider = provB;
        vm.expectRevert(abi.encodeWithSelector(CountersignOracle.ProviderMismatch.selector, vm.addr(PK_A), provA, provB));
        escrow.settle(id, j, g, c, ids());
    }

    function test_RevokedSignerRejected() public {
        bytes32 id = openEscrow();
        registry.revoke(vm.addr(PK_B));
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.95");
        vm.expectRevert(abi.encodeWithSelector(CountersignOracle.UnknownSigner.selector, vm.addr(PK_B)));
        escrow.settle(id, j, g, c, ids());
    }

    function test_RevertHeaderNotInStringValue() public {
        bytes32 id = openEscrow();
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.95");
        // response whose content lacks the header entirely
        j[0] = attest(PK_A, provA, j[0].reqBody, respBody("I cannot decide."));
        vm.expectRevert(CountersignOracle.HeaderNotFound.selector);
        escrow.settle(id, j, g, c, ids());
    }

    function test_RefundAfterDeadline() public {
        bytes32 id = openEscrow();
        vm.warp(block.timestamp + 8 days);
        uint256 before = usdc.balanceOf(payer);
        vm.prank(payer);
        escrow.refundAfterDeadline(id);
        assertEq(usdc.balanceOf(payer), before + 50e6);
    }

    function test_SettleRevertsWithoutEvidence() public {
        vm.prank(payer);
        bytes32 id = escrow.open(payee, arbiter, 50e6, uint64(block.timestamp + 7 days), RUBRIC, pol);
        (bytes32 r, bytes32 e) = hashes();
        (CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = bundle(r, e, "Y", "Y", "Y", "0.95");
        vm.expectRevert(CountersignEscrow.EvidenceMissing.selector);
        escrow.settle(id, j, g, c, ids());
    }

    function test_HeaderParsing() public view {
        (bytes32 r, bytes32 e) = (keccak256("r"), keccak256("e"));
        CountersignOracle.Attested memory a = attest(PK_A, provA, reqBody(r, e), respBody(string.concat(header("U", "1.00", r, e), "x")));
        (uint8 v, uint16 conf,, bytes32 m) = oracle.verifyOne(r, e, a);
        assertEq(v, 2);
        assertEq(conf, 10000);
        assertEq(m, keccak256("glm-5.3"));
    }

    // ---- single-judge mode (Galileo testnet: one live TeeML provider) ----------

    /// One judge; grounding and calibration come from the same provider and enclave key.
    function singleJudge(string memory v, string memory g, string memory conf)
        internal
        returns (bytes32 id, CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory gr, CountersignOracle.Attested memory c)
    {
        CountersignOracle.Policy memory one = CountersignOracle.Policy({judges: 1, minAgree: 1, minConfBps: 8500, requireGrounded: true});
        vm.prank(payer);
        id = escrow.open(payee, arbiter, 50e6, uint64(block.timestamp + 7 days), RUBRIC, one);
        vm.prank(payee);
        escrow.setEvidence(id, keccak256(bytes(EVIDENCE)), "0g://root");
        (bytes32 r, bytes32 e) = hashes();
        bytes memory req = reqBody(r, e);
        j = new CountersignOracle.Attested[](1);
        j[0] = attest(PK_A, provA, req, respBody(string.concat(header(v, "0.95", r, e), "All three items present.")));
        gr = attest(PK_A, provA, req, respBody(string.concat(header(g, "0.99", r, e), "0 unsupported claims.")));
        c = attest(PK_A, provA, req, respBody(string.concat(header("Y", conf, r, e), "Evidence is explicit.")));
    }

    function test_SingleJudge_ReleaseOnYes() public {
        (bytes32 id, CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = singleJudge("Y", "Y", "0.95");
        string[] memory rids = new string[](3);
        rids[0] = "req-a"; rids[1] = "req-g"; rids[2] = "req-c";
        escrow.settle(id, j, g, c, rids);
        assertEq(usdc.balanceOf(payee), 50e6);
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Resolved));
    }

    function test_SingleJudge_EscalateWhenUngrounded() public {
        (bytes32 id, CountersignOracle.Attested[] memory j, CountersignOracle.Attested memory g, CountersignOracle.Attested memory c) = singleJudge("Y", "N", "0.95");
        string[] memory rids = new string[](3);
        rids[0] = "req-a"; rids[1] = "req-g"; rids[2] = "req-c";
        escrow.settle(id, j, g, c, rids);
        assertEq(uint8(escrow.get(id).state), uint8(CountersignEscrow.State.Escalated));
        assertEq(usdc.balanceOf(payee), 0);
    }
}
