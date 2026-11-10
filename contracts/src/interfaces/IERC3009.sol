// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The EIP-3009 surface of Circle's FiatToken v2.x (Fuji USDC 0x5425…Bc65, mainnet USDC 0xB97E…a6E).
///         `receiveWithAuthorization` requires `msg.sender == to`, so only the receiving contract can
///         redeem the authorisation, and nobody can front-run it.
interface IERC3009 {
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
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
