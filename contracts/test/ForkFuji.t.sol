// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SignerRegistry} from "../src/SignerRegistry.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssayEscrow} from "../src/AssayEscrow.sol";
import {AssayValidator} from "../src/AssayValidator.sol";
import {IIdentityRegistry, IValidationRegistry} from "../src/interfaces/IERC8004.sol";
import {JudgeBase} from "./utils/JudgeBase.sol";

interface IIdentityWrite {
    function register(string calldata agentURI) external returns (uint256);
    function approve(address to, uint256 tokenId) external;
}

/// Full protected purchase against the REAL Fuji contracts: Circle USDC (EIP-3009, domain "USD Coin" v2)
/// and the ERC-8004 Identity and Validation registries.
///   FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc forge test --match-contract ForkFuji -vv
contract ForkFujiTest is JudgeBase {
    address constant USDC = 0x5425890298aed601595a70AB815c96711a31Bc65;
    address constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant VALIDATION = 0x8004Cb1BF31DAf7788923b405b754f57acEB4272;

    uint256 constant AGENT_PK = 0xA6E27;
    uint256 constant SELLER_PK = 0x5E11E8;

    SignerRegistry registry;
    AssayOracle oracle;
    AssayEscrow escrow;
    AssayValidator validator;

    function setUp() public {
        string memory rpc = vm.envOr("FUJI_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        registry = new SignerRegistry(address(this));
        oracle = new AssayOracle(registry);
        escrow = new AssayEscrow(IERC20(USDC), oracle);
        validator = new AssayValidator(
            IValidationRegistry(VALIDATION), IIdentityRegistry(IDENTITY), escrow, "https://node.test/escrows/", address(this)
        );
        registerJudges(registry);
    }

    function test_Fork_ProtectedPurchase_RealUSDC_RealERC8004() public {
        address agent = vm.addr(AGENT_PK);
        address seller = vm.addr(SELLER_PK);
        deal(USDC, agent, 5e6);
        assertEq(IERC20(USDC).balanceOf(agent), 5e6);

        // seller: ERC-8004 identity + opt in to self-filed validation records
        vm.startPrank(seller);
        uint256 agentId = IIdentityWrite(IDENTITY).register("https://seller.test/agent.json");
        IIdentityWrite(IDENTITY).approve(address(validator), agentId);
        vm.stopPrank();
        assertTrue(validator.canSelfFile(agentId));

        // buyer signs one gasless ReceiveWithAuthorization; someone else submits it
        (AssayEscrow.OpenAuth memory a, bytes32 termsNonce) = buildAuth(escrow, USDC, AGENT_PK, seller, 250_000, agentId, "fork");
        vm.prank(address(0xF00));
        bytes32 id = escrow.openWithAuthorization(a, RUBRIC, pol());
        assertEq(IERC20(USDC).balanceOf(address(escrow)), 250_000);

        (bool ok, bytes memory ret) = USDC.staticcall(abi.encodeWithSignature("authorizationState(address,bytes32)", agent, termsNonce));
        assertTrue(ok && abi.decode(ret, (bool)));

        bytes32 h = keccak256(bytes(EVIDENCE));
        escrow.setEvidenceWithReceipt(id, h, "node://e", signReceipt(SELLER_PK, escrow, id, h));
        (AssayOracle.Attested[] memory j, AssayOracle.Attested memory g, AssayOracle.Attested memory c) =
            bundle(keccak256(bytes(RUBRIC)), h, "Y", "Y", "Y", "0.95");
        uint256 gasBefore = gasleft();
        escrow.settle(id, j, g, c, ids());
        emit log_named_uint("settle gas (2 judges)", gasBefore - gasleft());
        assertEq(IERC20(USDC).balanceOf(seller), 250_000);

        assertEq(validator.record(id), 100);
        address[] memory vs = new address[](1);
        vs[0] = address(validator);
        (uint64 n, uint8 avg) = IValidationRegistry(VALIDATION).getSummary(agentId, vs, "assay");
        assertEq(n, 1);
        assertEq(avg, 100);
    }
}
