// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SignerRegistry
/// @notice Mirror of 0G Compute `InferenceServing.getService(provider).teeSignerAddress`
///         on the chain where Verdict settles. Each record carries the 0G block number and
///         transaction it was read from so anyone can audit the mirror against 0G chain.
/// @dev    Hackathon trust model: the owner (the registry mirror script) is trusted to copy
///         records faithfully. Roadmap: replace `sync` with a 0G chain state proof.
contract SignerRegistry is Ownable {
    struct Record {
        address provider;   // 0G provider address (Service.provider)
        bytes32 model;      // keccak256(bytes(Service.model))
        uint64 zgBlock;     // 0G block the record was read at
        bytes32 zgTxHash;   // 0G tx that last set the service (or 0 if read from state)
        bool active;
    }

    mapping(address signer => Record) public records;

    event Synced(address indexed signer, address indexed provider, string model, uint64 zgBlock, bytes32 zgTxHash);
    event Revoked(address indexed signer);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Register or refresh an enclave signer for a provider/model.
    function sync(address provider, address signer, string calldata model, uint64 zgBlock, bytes32 zgTxHash)
        external
        onlyOwner
    {
        require(signer != address(0) && provider != address(0), "zero address");
        records[signer] = Record({
            provider: provider,
            model: keccak256(bytes(model)),
            zgBlock: zgBlock,
            zgTxHash: zgTxHash,
            active: true
        });
        emit Synced(signer, provider, model, zgBlock, zgTxHash);
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
