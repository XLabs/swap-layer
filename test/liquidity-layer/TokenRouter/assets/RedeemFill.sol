// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";

import {IWormhole} from "wormhole-sdk/interfaces/IWormhole.sol";
import {toUniversalAddress, fromUniversalAddress} from "wormhole-sdk/Utils.sol";

// import {IMatchingEngine} from "liquidity-layer/IMatchingEngine.sol";

import {Admin} from "../../shared/Admin.sol";
import {Messages} from "../../shared/Messages.sol";

import "./Errors.sol";
import {State} from "./State.sol";

import "liquidity-layer/IRedeemFill.sol";

abstract contract RedeemFill is IRedeemFill, Admin, State {
    using Messages for *;

    /// @inheritdoc IRedeemFill
    function redeemFill(OrderResponse calldata response) external returns (RedeemedFill memory) {
        uint16 emitterChain = response.encodedWormholeMessage.unsafeEmitterChainFromVaa();
        // bytes32 emitterAddress = response.encodedWormholeMessage.unsafeEmitterAddressFromVaa();

        // // If the emitter is the matching engine, and this TokenRouter is on the same chain
        // // as the matching engine, then this is a fast fill.
        // if (
        //     (emitterChain == _matchingEngineChain && _chainId == _matchingEngineChain)
        //         && emitterAddress == _matchingEngineAddress
        // ) {
        //     return _handleFastFill(response.encodedWormholeMessage);
        // } else {
            return _handleFill(emitterChain, response);
        // }
    }

    // ------------------------------- Private ---------------------------------

    function _handleFill(uint16 emitterChain, OrderResponse calldata response)
        private
        returns (RedeemedFill memory)
    {
        (IWormhole.VM memory vm,, uint256 amount,,, bytes memory payload) = verifyVaaAndMint(
            response.circleBridgeMessage,
            response.circleAttestation,
            response.encodedWormholeMessage
        );

        Messages.Fill memory fill = payload.decodeFill();

        // Verify that the sender is a known router or the matching engine.
        if (vm.emitterAddress != _matchingEngineAddress || emitterChain != _matchingEngineChain) {
            bytes32 fromRouter = getRouter(emitterChain);
            if (vm.emitterAddress != fromRouter) {
                revert ErrInvalidSourceRouter(vm.emitterAddress, fromRouter);
            }
        }

        _verifyRedeemer(fill.redeemer);

        // Transfer token amount to redeemer.
        SafeERC20.safeTransfer(_orderToken, msg.sender, amount);

        return RedeemedFill({
            sender: fill.orderSender,
            senderChain: fill.sourceChain,
            token: address(_orderToken),
            amount: amount,
            message: fill.redeemerMessage
        });
    }

    // function _handleFastFill(bytes calldata fastFillVaa) private returns (RedeemedFill memory) {
    //     // Call the Matching Engine to redeem the fill directly.
    //     Messages.FastFill memory fastFill = IMatchingEngine(
    //         fromUniversalAddress(_matchingEngineAddress)
    //     ).redeemFastFill(fastFillVaa);

    //     _verifyRedeemer(fastFill.fill.redeemer);

    //     // Transfer token amount to redeemer.
    //     SafeERC20.safeTransfer(_orderToken, msg.sender, fastFill.fillAmount);

    //     return RedeemedFill({
    //         sender: fastFill.fill.orderSender,
    //         senderChain: fastFill.fill.sourceChain,
    //         token: address(_orderToken),
    //         amount: fastFill.fillAmount,
    //         message: fastFill.fill.redeemerMessage
    //     });
    // }

    function _verifyRedeemer(bytes32 expectedRedeemer) private view {
        // Make sure the redeemer is who we expect.
        bytes32 redeemer = toUniversalAddress(msg.sender);
        if (redeemer != expectedRedeemer) {
            revert ErrInvalidRedeemer(redeemer, expectedRedeemer);
        }
    }
}
