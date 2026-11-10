// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice USDC stand-in with Circle FiatToken's EIP-3009 `receiveWithAuthorization` semantics:
///         domain ("USD Coin", "2"), caller must be `to`, time window, one-shot nonce per payer.
contract MockUSDC3009 is ERC20, EIP712 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    constructor() ERC20("USD Coin", "USDC") EIP712("USD Coin", "2") {}

    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function DOMAIN_SEPARATOR() external view returns (bytes32) { return _domainSeparatorV4(); }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        require(ECDSA.recover(digest, v, r, s) == from, "FiatTokenV2: invalid signature");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}

/// @notice ERC-8004 IdentityRegistry stand-in: an ERC-721 whose ids start at a non-zero offset like Fuji's.
contract MockIdentityRegistry is ERC721 {
    uint256 public nextId = 1000;

    constructor() ERC721("AgentIdentity", "AGENT") {}

    function register(string calldata) external returns (uint256 agentId) {
        agentId = nextId++;
        _safeMint(msg.sender, agentId);
    }
}

interface IIdentityView {
    function ownerOf(uint256) external view returns (address);
    function getApproved(uint256) external view returns (address);
    function isApprovedForAll(address, address) external view returns (bool);
}

/// @notice Logic copy of ERC-8004 ValidationRegistryUpgradeable v2.0.0 (deployed on Fuji), minus the proxy.
contract MockValidationRegistry {
    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool hasResponse;
    }

    address public immutable identityRegistry;
    mapping(bytes32 => ValidationStatus) internal validations;
    mapping(uint256 => bytes32[]) internal agentValidations;

    event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash);
    event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag);

    constructor(address identity_) { identityRegistry = identity_; }

    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash) external {
        require(validatorAddress != address(0), "bad validator");
        require(validations[requestHash].validatorAddress == address(0), "exists");
        IIdentityView registry = IIdentityView(identityRegistry);
        address owner = registry.ownerOf(agentId);
        require(
            msg.sender == owner || registry.isApprovedForAll(owner, msg.sender) || registry.getApproved(agentId) == msg.sender,
            "Not authorized"
        );
        validations[requestHash] = ValidationStatus(validatorAddress, agentId, 0, bytes32(0), "", block.timestamp, false);
        agentValidations[agentId].push(requestHash);
        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(bytes32 requestHash, uint8 response, string calldata responseURI, bytes32 responseHash, string calldata tag) external {
        ValidationStatus storage s = validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        require(msg.sender == s.validatorAddress, "not validator");
        require(response <= 100, "resp>100");
        s.response = response;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        s.hasResponse = true;
        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate)
    {
        ValidationStatus memory s = validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        uint256 total;
        bytes32[] storage hs = agentValidations[agentId];
        for (uint256 i; i < hs.length; i++) {
            ValidationStatus storage s = validations[hs[i]];
            bool mv = validatorAddresses.length == 0;
            for (uint256 j; !mv && j < validatorAddresses.length; j++) {
                if (s.validatorAddress == validatorAddresses[j]) mv = true;
            }
            bool mt = bytes(tag).length == 0 || keccak256(bytes(s.tag)) == keccak256(bytes(tag));
            if (mv && mt && s.hasResponse) { total += s.response; count++; }
        }
        avgResponse = count > 0 ? uint8(total / count) : 0;
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return agentValidations[agentId];
    }
}

/// @notice A smart-contract seller wallet (ERC-1271) controlled by one EOA key.
contract Mock1271Wallet is IERC1271 {
    address public immutable signer;
    constructor(address signer_) { signer = signer_; }
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return ECDSA.recover(hash, sig) == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
