// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-8004 ValidationRegistry v2.0.0, as deployed on Avalanche Fuji at
///         0x8004Cb1BF31DAf7788923b405b754f57acEB4272 (erc-8004/erc-8004-contracts,
///         ValidationRegistryUpgradeable.sol). `validationRequest` accepts the agent's owner,
///         an operator approved for all of the owner's agents, or the single-token approved address.
interface IValidationRegistry {
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external;

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

    /// @dev reverts with "unknown" when no request exists for `requestHash`
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse);

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory);
}

/// @notice ERC-8004 IdentityRegistry v2.0.0 (ERC-721), Fuji 0x8004A818BFB912233c491871b3d84c89A494BD9e.
///         The Fuji deployment has no `getAgentWallet`, so the payee is matched by `ownerOf`.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getApproved(uint256 agentId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}
