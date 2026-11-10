// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignerRegistry} from "./SignerRegistry.sol";

/// @title AssayOracle
/// @notice Verifies that each judge verdict was signed by a registered judge key over the exact
///         model request and response bytes, then applies a quorum policy. Pure verification:
///         no owner, no state.
///
/// A judge signer signs the ASCII text
///
///     hex(sha256(requestBody)) ":" hex(sha256(responseBody))        // 64 + 1 + 64 = 129 bytes, lowercase
///
/// with EIP-191 `personal_sign`. This is the same layout TEE inference gateways use for signed
/// chat completions, so a self-attested judge key can later be swapped for an enclave key without
/// changing this contract. The contract receives the exact request and response bytes, recomputes
/// both SHA-256 hashes, rebuilds the signed text, recovers the signer, and only then reads the
/// verdict out of the response body.
///
/// The judge prompt forces the model's reply to begin with a fixed-width header:
///
///     VERDICT:Y;CONF:0.93;RUBRIC:0x<64 hex>;EVID:0x<64 hex>;<rationale>
///     ^0      ^8 ^10   ^15  ^20     ^27      ^93  ^99        ^165
///
/// The header is located inside the response JSON (`"content":"VERDICT:...`), and the request
/// body must contain both escrow hashes, so a genuine signature over a verdict for a different
/// escrow fails on the hash checks rather than on the signature.
contract AssayOracle {
    using ECDSA for bytes32;

    struct Attested {
        bytes reqBody;    // exact bytes sent to the model API
        bytes respBody;   // exact bytes received from it
        bytes signature;  // 65-byte EIP-191 signature over signedText(reqBody, respBody)
        address provider; // judge provider id; must match the registry record for the signer
    }

    struct Policy {
        uint8 judges;          // number of judge attestations required
        uint8 minAgree;        // judges that must share the first judge's verdict
        uint16 minConfBps;     // calibration confidence floor in basis points
        bool requireGrounded;  // grounding attestation must say 'Y'
    }

    uint8 public constant NO = 0;
    uint8 public constant YES = 1;
    uint8 public constant ESCALATE = 2;

    uint256 public constant HEADER_LEN = 166;
    bytes8 private constant HEADER_TAG = "VERDICT:";

    SignerRegistry public immutable registry;

    error BadHeader(uint256 offset);
    error HeaderNotFound();
    error UnknownSigner(address signer);
    error ProviderMismatch(address signer, address expected, address given);
    error RequestNotBound(bytes32 hash, bool rubric);
    error WrongEscrow(bytes32 want, bytes32 got, bool rubric);
    error SameModelTwice(bytes32 model);
    error JudgeCount(uint256 want, uint256 got);

    constructor(SignerRegistry registry_) {
        registry = registry_;
    }

    /// @notice The exact text a judge signer signs for this request/response pair.
    function signedText(bytes calldata reqBody, bytes calldata respBody) public pure returns (bytes memory text) {
        bytes32 r = sha256(reqBody);
        bytes32 p = sha256(respBody);
        text = new bytes(129);
        _hex64(r, text, 0);
        text[64] = ":";
        _hex64(p, text, 65);
    }

    /// @notice Verify one attestation against an escrow's rubric and evidence hashes.
    function verifyOne(bytes32 rubricHash, bytes32 evidenceHash, Attested calldata a)
        public
        view
        returns (uint8 verdict, uint16 confBps, address signer, bytes32 model)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(signedText(a.reqBody, a.respBody));
        signer = digest.recover(a.signature);
        if (!registry.isSigner(signer)) revert UnknownSigner(signer);
        address prov = registry.providerOf(signer);
        if (prov != a.provider) revert ProviderMismatch(signer, prov, a.provider);
        model = registry.modelOf(signer);

        // the prompt the judge saw must name this escrow
        if (!_contains(a.reqBody, _hex0x(rubricHash))) revert RequestNotBound(rubricHash, true);
        if (!_contains(a.reqBody, _hex0x(evidenceHash))) revert RequestNotBound(evidenceHash, false);

        uint256 off = _findHeader(a.respBody);
        (verdict, confBps) = _parseHeader(a.respBody, off);
        bytes32 r = _hexAt(a.respBody, off + 29);
        if (r != rubricHash) revert WrongEscrow(rubricHash, r, true);
        bytes32 e = _hexAt(a.respBody, off + 101);
        if (e != evidenceHash) revert WrongEscrow(evidenceHash, e, false);
    }

    /// @notice Apply the quorum policy to a bundle. Reverts on any invalid attestation;
    ///         returns ESCALATE (never reverts) when the policy is not met.
    function resolve(
        bytes32 rubricHash,
        bytes32 evidenceHash,
        Policy calldata p,
        Attested[] calldata judges,
        Attested calldata grounding,
        Attested calldata calibration
    ) external view returns (uint8 outcome, address[] memory signers) {
        if (judges.length != p.judges) revert JudgeCount(p.judges, judges.length);
        signers = new address[](judges.length + 2);
        bytes32[] memory models = new bytes32[](judges.length);

        uint8 first;
        uint8 agree;
        for (uint256 i = 0; i < judges.length; i++) {
            (uint8 v,, address s, bytes32 m) = verifyOne(rubricHash, evidenceHash, judges[i]);
            for (uint256 j = 0; j < i; j++) {
                if (models[j] == m) revert SameModelTwice(m);
            }
            models[i] = m;
            signers[i] = s;
            if (i == 0) first = v;
            if (v == first) agree++;
        }

        (uint8 g,, address gs,) = verifyOne(rubricHash, evidenceHash, grounding);
        signers[judges.length] = gs;
        (, uint16 conf, address cs,) = verifyOne(rubricHash, evidenceHash, calibration);
        signers[judges.length + 1] = cs;

        if (first == 2) return (ESCALATE, signers);
        if (agree < p.minAgree) return (ESCALATE, signers);
        if (p.requireGrounded && g != YES) return (ESCALATE, signers);
        if (conf < p.minConfBps) return (ESCALATE, signers);
        return (first, signers);
    }

    // ---- byte search ---------------------------------------------------------

    function _load8(bytes calldata b, uint256 i) private pure returns (bytes8 w) {
        assembly {
            w := and(calldataload(add(b.offset, i)), shl(192, 0xFFFFFFFFFFFFFFFF))
        }
    }

    /// @dev first index of `needle` (length >= 8) in `hay`, or type(uint256).max
    function _indexOf(bytes calldata hay, bytes memory needle) private pure returns (uint256) {
        uint256 n = needle.length;
        if (hay.length < n) return type(uint256).max;
        bytes8 prefix;
        assembly { prefix := and(mload(add(needle, 32)), shl(192, 0xFFFFFFFFFFFFFFFF)) }
        bytes32 want = keccak256(needle);
        uint256 last = hay.length - n;
        for (uint256 i = 0; i <= last; i++) {
            if (_load8(hay, i) == prefix && keccak256(hay[i:i + n]) == want) return i;
        }
        return type(uint256).max;
    }

    function _contains(bytes calldata hay, bytes memory needle) private pure returns (bool) {
        return _indexOf(hay, needle) != type(uint256).max;
    }

    /// @dev offset of the first `VERDICT:` that starts a JSON string value (preceded by a quote)
    function _findHeader(bytes calldata resp) private pure returns (uint256) {
        if (resp.length < HEADER_LEN + 1) revert HeaderNotFound();
        uint256 last = resp.length - HEADER_LEN;
        for (uint256 i = 1; i <= last; i++) {
            if (_load8(resp, i) == HEADER_TAG && resp[i - 1] == '"') return i;
        }
        revert HeaderNotFound();
    }

    // ---- header parsing -------------------------------------------------------

    function _parseHeader(bytes calldata t, uint256 o) private pure returns (uint8 verdict, uint16 confBps) {
        if (t.length < o + HEADER_LEN) revert BadHeader(t.length);
        bytes1 v = t[o + 8];
        if (v == "Y") verdict = YES;
        else if (v == "N") verdict = NO;
        else if (v == "U") verdict = ESCALATE;
        else revert BadHeader(8);
        if (t[o + 9] != ";") revert BadHeader(9);
        if (keccak256(t[o + 10:o + 15]) != keccak256("CONF:")) revert BadHeader(10);
        uint8 d0 = _digit(t[o + 15], 15);
        if (t[o + 16] != ".") revert BadHeader(16);
        uint8 d1 = _digit(t[o + 17], 17);
        uint8 d2 = _digit(t[o + 18], 18);
        confBps = uint16(d0) * 10000 + uint16(d1) * 1000 + uint16(d2) * 100;
        if (confBps > 10000) revert BadHeader(15);
        if (t[o + 19] != ";") revert BadHeader(19);
        if (keccak256(t[o + 20:o + 27]) != keccak256("RUBRIC:")) revert BadHeader(20);
        if (t[o + 27] != "0" || t[o + 28] != "x") revert BadHeader(27);
        if (t[o + 93] != ";") revert BadHeader(93);
        if (keccak256(t[o + 94:o + 99]) != keccak256("EVID:")) revert BadHeader(94);
        if (t[o + 99] != "0" || t[o + 100] != "x") revert BadHeader(99);
        if (t[o + 165] != ";") revert BadHeader(165);
    }

    function _digit(bytes1 c, uint256 off) private pure returns (uint8) {
        if (c < "0" || c > "9") revert BadHeader(off);
        return uint8(c) - 48;
    }

    function _nibble(bytes1 c, uint256 off) private pure returns (uint256) {
        if (c >= "0" && c <= "9") return uint8(c) - 48;
        if (c >= "a" && c <= "f") return uint8(c) - 87;
        if (c >= "A" && c <= "F") return uint8(c) - 55;
        revert BadHeader(off);
    }

    /// @dev parse 64 hex chars at `off` into bytes32
    function _hexAt(bytes calldata t, uint256 off) private pure returns (bytes32 out) {
        uint256 acc;
        for (uint256 i = 0; i < 64; i++) {
            acc = (acc << 4) | _nibble(t[off + i], off + i);
        }
        out = bytes32(acc);
    }

    // ---- hex encoding --------------------------------------------------------

    bytes16 private constant ALPHABET = "0123456789abcdef";

    function _hex64(bytes32 v, bytes memory out, uint256 at) private pure {
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(v[i]);
            out[at + 2 * i] = ALPHABET[b >> 4];
            out[at + 2 * i + 1] = ALPHABET[b & 0x0f];
        }
    }

    function _hex0x(bytes32 v) private pure returns (bytes memory out) {
        out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        _hex64(v, out, 2);
    }
}
