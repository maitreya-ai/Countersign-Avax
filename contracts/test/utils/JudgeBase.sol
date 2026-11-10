// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignerRegistry} from "../../src/SignerRegistry.sol";
import {AssayOracle} from "../../src/AssayOracle.sol";
import {AssayEscrow} from "../../src/AssayEscrow.sol";

/// @notice Shared helpers: judge keys, signed verdict bundles, EIP-3009 and receipt signing.
abstract contract JudgeBase is Test {
    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    uint256 internal constant PK_G = 0xC0FFEE;
    uint256 internal constant PK_C = 0xD00D;

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    string internal constant RUBRIC =
        "Exactly 5 bullets. Every bullet is supported by a sentence in the source document. No facts that are not in the source.";
    string internal constant EVIDENCE = "ASSAY-EVIDENCE v1\nREQUEST POST /honest/summarize\n{...}\n\nRESPONSE 200\n- a\n- b";

    function registerJudges(SignerRegistry registry) internal {
        registry.sync(vm.addr(PK_A), vm.addr(PK_A), "groq:openai/gpt-oss-120b", 0, bytes32(0));
        registry.sync(vm.addr(PK_B), vm.addr(PK_B), "groq:qwen/qwen3-32b", 0, bytes32(0));
        registry.sync(vm.addr(PK_G), vm.addr(PK_G), "groq:grounding", 0, bytes32(0));
        registry.sync(vm.addr(PK_C), vm.addr(PK_C), "groq:calibration", 0, bytes32(0));
    }

    function hx(bytes32 v) internal pure returns (string memory) {
        return Strings.toHexString(uint256(v), 32);
    }

    function header(string memory v, string memory conf, bytes32 r, bytes32 e) internal pure returns (string memory) {
        return string.concat("VERDICT:", v, ";CONF:", conf, ";RUBRIC:", hx(r), ";EVID:", hx(e), ";");
    }

    function reqBody(bytes32 r, bytes32 e) internal pure returns (bytes memory) {
        return bytes(string.concat('{"messages":[{"role":"system","content":"judge RUBRIC:', hx(r), " EVID:", hx(e), '"}]}'));
    }

    function respBody(string memory content) internal pure returns (bytes memory) {
        return bytes(string.concat('{"id":"c1","choices":[{"message":{"role":"assistant","content":"', content, '"}}]}'));
    }

    function signedText(bytes memory req, bytes memory resp) internal pure returns (bytes memory out) {
        bytes memory a = bytes(Strings.toHexString(uint256(sha256(req)), 32));
        bytes memory b = bytes(Strings.toHexString(uint256(sha256(resp)), 32));
        out = new bytes(129);
        for (uint256 i = 0; i < 64; i++) { out[i] = a[i + 2]; out[65 + i] = b[i + 2]; }
        out[64] = ":";
    }

    function attest(uint256 pk, bytes memory req, bytes memory resp) internal pure returns (AssayOracle.Attested memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(signedText(req, resp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return AssayOracle.Attested({reqBody: req, respBody: resp, signature: abi.encodePacked(r, s, v), provider: vm.addr(pk)});
    }

    /// @dev two judges with verdicts vA/vB, grounding g, calibration conf
    function bundle(bytes32 r, bytes32 e, string memory vA, string memory vB, string memory g, string memory conf)
        internal
        pure
        returns (AssayOracle.Attested[] memory judges, AssayOracle.Attested memory grounding, AssayOracle.Attested memory calibration)
    {
        bytes memory req = reqBody(r, e);
        judges = new AssayOracle.Attested[](2);
        judges[0] = attest(PK_A, req, respBody(string.concat(header(vA, "0.95", r, e), "five grounded bullets")));
        judges[1] = attest(PK_B, req, respBody(string.concat(header(vB, "0.92", r, e), "bullets match source")));
        grounding = attest(PK_G, req, respBody(string.concat(header(g, "0.99", r, e), "0 unsupported claims.")));
        calibration = attest(PK_C, req, respBody(string.concat(header("Y", conf, r, e), "judges agree")));
    }

    function ids() internal pure returns (string[] memory s) {
        s = new string[](4);
        s[0] = "a"; s[1] = "b"; s[2] = "g"; s[3] = "c";
    }

    function pol() internal pure returns (AssayOracle.Policy memory) {
        return AssayOracle.Policy({judges: 2, minAgree: 2, minConfBps: 8500, requireGrounded: true});
    }

    /// @dev EIP-712 signature of USDC ReceiveWithAuthorization for `usdc` (domain "USD Coin", "2").
    function signReceive(uint256 pk, address usdc, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("USD Coin")),
                keccak256(bytes("2")),
                block.chainid,
                usdc
            )
        );
        bytes32 structHash = keccak256(abi.encode(RECEIVE_TYPEHASH, vm.addr(pk), to, value, validAfter, validBefore, nonce));
        (v, r, s) = vm.sign(pk, MessageHashUtils.toTypedDataHash(domain, structHash));
    }

    /// @dev Build and sign an OpenAuth for `escrow` under the default policy and RUBRIC.
    function buildAuth(
        AssayEscrow escrow,
        address usdc,
        uint256 payerPk,
        address payee,
        uint96 amount,
        uint256 agentId,
        bytes32 salt
    ) internal view returns (AssayEscrow.OpenAuth memory a, bytes32 termsNonce) {
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        termsNonce = escrow.termsHash(payee, address(0), amount, deadline, keccak256(bytes(RUBRIC)), pol(), agentId, salt);
        (uint8 v, bytes32 r, bytes32 s) =
            signReceive(payerPk, usdc, address(escrow), amount, block.timestamp - 1, block.timestamp + 2 minutes, termsNonce);
        a = AssayEscrow.OpenAuth({
            payer: vm.addr(payerPk),
            payee: payee,
            arbiter: address(0),
            amount: amount,
            deadline: deadline,
            agentId: agentId,
            salt: salt,
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 2 minutes,
            v: v,
            r: r,
            s: s
        });
    }

    function signReceipt(uint256 pk, AssayEscrow escrow, bytes32 id, bytes32 evidenceHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.receiptDigest(id, evidenceHash));
        return abi.encodePacked(r, s, v);
    }
}
