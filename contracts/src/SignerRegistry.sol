// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SignerRegistry
/// @notice The set of judge signing keys the oracle accepts. Each signer is bound to one provider id
///         and one model, so the oracle can require that judges are distinct models. Every change is
///         an event, so anyone can audit which keys were trusted at any block.
/// @dev    Trust model: the owner decides which judge keys count. In self-attested mode the keys are
///         derived per model by the judge node; with TEE judges they are the enclave signing keys, and
///         `sourceBlock` / `sourceTx` point at the attestation record the key was copied from.
contract SignerRegistry is Ownable {
    struct Record {
        address provider;    // provider id the signer speaks for
        bytes32 model;       // keccak256(bytes(model id))
        uint64 sourceBlock;  // block of the attestation record the key came from (0 = self-attested)
        bytes32 sourceTx;    // transaction of that record (0 = none)
        bool active;
    }

    mapping(address signer => Record) public records;

    event Synced(address indexed signer, address indexed provider, string model, uint64 sourceBlock, bytes32 sourceTx);
    event Revoked(address indexed signer);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Register or refresh a judge signer for a provider/model.
    function sync(address provider, address signer, string calldata model, uint64 sourceBlock, bytes32 sourceTx)
        external
        onlyOwner
    {
        require(signer != address(0) && provider != address(0), "zero address");
        records[signer] = Record({
            provider: provider,
            model: keccak256(bytes(model)),
            sourceBlock: sourceBlock,
            sourceTx: sourceTx,
            active: true
        });
        emit Synced(signer, provider, model, sourceBlock, sourceTx);
    }

    function revoke(address signer) external onlyOwner {
        records[signer].active = false;
        emit Revoked(signer);
    }

    function isSigner(address signer) external view returns (bool) {
        return records[signer].active;
    }

    function modelOf(address signer) external view returns (bytes32) {
        return records[signer].model;
    }

    function providerOf(address signer) external view returns (address) {
        return records[signer].provider;
    }
}
