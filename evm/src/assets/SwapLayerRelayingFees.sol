// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.24;

import "wormhole-sdk/libraries/BytesParsing.sol";

import { InvalidChainId, SwapLayerBase } from "./SwapLayerBase.sol";
import { Percentage, PercentageLib } from "./Percentage.sol";
import { GasPrice, GasPriceLib } from "./GasPrice.sol";
import { GasDropoff, GasDropoffLib } from "./GasDropoff.sol";
import { FeeParams, FeeParamsLib } from "./FeeParams.sol";
import {
  SOLANA_CHAIN_ID,
  UNIVERSAL_ADDRESS_SIZE,
  SWAP_TYPE_UNISWAPV3,
  SWAP_TYPE_TRADERJOE,
  SWAP_TYPE_JUPITERV6,
  IoToken
} from "./Params.sol";

struct FeeParamsState {
  // chainId => fee parameters of that chain
  mapping(uint16 => FeeParams) chainMapping;
}

// keccak256("FeeParamsState") - 1
bytes32 constant FEE_PARAMS_STORAGE_SLOT =
  0x390950e512c08746510d8189287f633f84012f0678caa6bc6558847bdd158b23;

function feeParamsState() pure returns (FeeParamsState storage state) {
  assembly ("memory-safe") {
    state.slot := FEE_PARAMS_STORAGE_SLOT
  }
}

error ExceedsMaxGasDropoff(uint requested, uint maximum);
error RelayingDisabledForChain();
error InvalidSwapTypeForChain(uint16 chain, uint swapType);

//the additional gas cost is likely worth the cost of being able to reconstruct old fees
event FeeParamsUpdated(uint16 indexed chainId, bytes32 feeParams);

enum FeeUpdate {
  GasPrice,
  GasTokenPrice,
  BaseFee,
  GasPriceMargin,
  GasDropoffMargin,
  MaxGasDropoff
}

uint constant SOLANA_ATA_RENT_LAMPORTS = 2039280;
uint constant LAMPORTS_PER_SOL = 1e9;

//TODO the following are estimates from forge tests (already adjusted upwards for more guardians
//     on mainnet) - refine further with testnet measurements (+guardian count adjustments!)
uint constant GAS_OVERHEAD           = 390e3;
uint constant DROPOFF_GAS_OVERHEAD   =  32e3;
uint constant UNISWAP_GAS_OVERHEAD   =  10e3;
uint constant UNISWAP_GAS_PER_SWAP   = 150e3;
uint constant TRADERJOE_GAS_OVERHEAD =  30e3;
uint constant TRADERJOE_GAS_PER_SWAP = 100e3;

abstract contract SwapLayerRelayingFees is SwapLayerBase {
  using BytesParsing for bytes;

  function _batchFeeUpdates(bytes memory updates) internal {
    uint16 curChain = 0;
    FeeParams curParams;
    uint offset = 0;
    while (offset < updates.length) {
      uint16 updateChain;
      (updateChain, offset) = updates.asUint16Unchecked(offset);
      if (updateChain == 0)
        revert InvalidChainId();

      if (curChain != updateChain) {
        if (curChain != 0)
          _setFeeParams(curChain, curParams);

        curChain = updateChain;
        curParams = _getFeeParams(updateChain);
      }

      uint8 update_;
      (update_, offset) = updates.asUint8Unchecked(offset);
      FeeUpdate update = FeeUpdate(update_);
      if (update == FeeUpdate.GasPrice) {
        uint32 gasPrice;
        (gasPrice, offset) = updates.asUint32Unchecked(offset);
        curParams = curParams.gasPrice(GasPrice.wrap(gasPrice));
      }
      else if (update == FeeUpdate.GasTokenPrice) {
        uint64 gasTokenPrice;
        (gasTokenPrice, offset) = updates.asUint64Unchecked(offset);
        curParams = curParams.gasTokenPrice(gasTokenPrice);
      }
      else if (update == FeeUpdate.BaseFee) {
        uint32 baseFee;
        (baseFee, offset) = updates.asUint32Unchecked(offset);
        curParams = curParams.baseFee(baseFee);
      }
      else if (update == FeeUpdate.GasPriceMargin) {
        uint16 gasPriceMargin;
        (gasPriceMargin, offset) = updates.asUint16Unchecked(offset);
        curParams = curParams.gasPriceMargin(PercentageLib.checkedWrap(gasPriceMargin));
      }
      else if (update == FeeUpdate.GasDropoffMargin) {
        uint16 gasDropoffMargin;
        (gasDropoffMargin, offset) = updates.asUint16Unchecked(offset);
        curParams = curParams.gasDropoffMargin(PercentageLib.checkedWrap(gasDropoffMargin));
      }
      else if (update == FeeUpdate.MaxGasDropoff) {
        uint32 maxGasDropoff;
        (maxGasDropoff, offset) = updates.asUint32Unchecked(offset);
        curParams = curParams.maxGasDropoff(GasDropoff.wrap(maxGasDropoff));
      }
      else
        _assertExhaustive();
    }
    updates.checkLength(offset);

    if (curChain != 0)
      _setFeeParams(curChain, curParams);
  }

  function _calcRelayingFee(
    uint16 targetChain,
    GasDropoff gasDropoff_,
    IoToken, //outputTokenType,
    uint swapCount,
    uint swapType
  ) internal view returns (uint relayingFee) { unchecked {
    FeeParams feeParams = _getFeeParams(targetChain);

    //setting the base fee to uint32 max disables relaying
    if (feeParams.baseFee() == type(uint32).max)
      revert RelayingDisabledForChain();

    relayingFee = feeParams.baseFee();

    uint gasDropoff = gasDropoff_.from();
    if (gasDropoff > 0) {
      uint maxGasDropoff = feeParams.maxGasDropoff().from();
      if (gasDropoff > maxGasDropoff)
        revert ExceedsMaxGasDropoff(gasDropoff, maxGasDropoff);

      relayingFee += feeParams.gasDropoffMargin().compoundUnchecked(
        gasDropoff * feeParams.gasTokenPrice()
      ) / 1 ether;
    }

    if (targetChain == SOLANA_CHAIN_ID) {
      //TODO figure out what other (dynamic) fees might go into Solana fee calculations
      if (swapCount != 0 && swapType != SWAP_TYPE_JUPITERV6)
        revert InvalidSwapTypeForChain(targetChain, swapType);

      //add the cost of ATA rent (since any swap can fail, we might have to spawn a usdc ATA)
      relayingFee += feeParams.gasDropoffMargin().compoundUnchecked(
        SOLANA_ATA_RENT_LAMPORTS * feeParams.gasTokenPrice()
      ) / LAMPORTS_PER_SOL;
    }
    else { //EVM chains
      uint totalGas = GAS_OVERHEAD;
      if (gasDropoff > 0)
        totalGas += DROPOFF_GAS_OVERHEAD;

      if (swapCount != 0) {
        uint overhead;
        uint gasPerSwap;
        if (swapType == SWAP_TYPE_UNISWAPV3)
          (overhead, gasPerSwap) = (  UNISWAP_GAS_OVERHEAD,   UNISWAP_GAS_PER_SWAP);
        else if (swapType == SWAP_TYPE_TRADERJOE)
          (overhead, gasPerSwap) = (TRADERJOE_GAS_OVERHEAD, TRADERJOE_GAS_PER_SWAP);
        else
          revert InvalidSwapTypeForChain(targetChain, swapType);

        totalGas += overhead + gasPerSwap * swapCount;
      }

      //no overflow possible:
      //  gasPrice fits in 7 bytes (4 bytes * 1e6)
      //  gasTokenPrice is 8 bytes
      //  total gas fits in 3 bytes (never more than 2^24 = 16M gas)
      //  compound uses at most 2 additional bytes
      relayingFee += feeParams.gasPriceMargin().compoundUnchecked(
        totalGas * feeParams.gasPrice().from() * feeParams.gasTokenPrice()
      ) / 1 ether;
    }
  }}

  function _getFeeParams(uint16 chainId) internal view returns (FeeParams) {
    return feeParamsState().chainMapping[chainId];
  }

  function _setFeeParams(uint16 chainId, FeeParams params) internal {
    feeParamsState().chainMapping[chainId] = params;
    emit FeeParamsUpdated(chainId, bytes32(FeeParams.unwrap(params)));
  }
}
