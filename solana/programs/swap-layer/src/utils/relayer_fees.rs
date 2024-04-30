use crate::utils::gas_dropoff::denormalize_gas_dropoff;
use crate::{
    error::SwapLayerError,
    state::{ExecutionParams, RelayParams},
};
use anchor_lang::prelude::*;
use swap_layer_messages::types::SwapType;

// EVM gas overheads in gas units.
const EVM_GAS_OVERHEAD: u64 = 100_000;
const DROPOFF_GAS_OVERHEAD: u64 = 10_000;
const UNISWAP_GAS_OVERHEAD: u64 = 100_000;
const UNISWAP_GAS_PER_SWAP: u64 = 100_000;
const TRADERJOE_GAS_OVERHEAD: u64 = 100_000;
const TRADERJOE_GAS_PER_SWAP: u64 = 100_000;

const ONE_SOL: u64 = 1_000_000_000;
const GAS_PRICE_SCALAR: u32 = 1_000_000;

// 1 ETH in WEI.
const ONE_ETHER: u64 = 1_000_000_000_000_000_000;

pub fn denormalize_gas_price(gas_price: u32) -> u64 {
    u64::from(gas_price).saturating_mul(GAS_PRICE_SCALAR.into())
}

fn compound(percentage: u32, base: u64) -> Option<u64> {
    if percentage == 0 {
        Some(base)
    } else {
        // NOTE: Upcasting from u32 to u128 is safe here.
        #[allow(clippy::as_conversions)]
        #[allow(clippy::cast_possible_truncation)]
        const MAX: u128 = crate::MAX_BPS as u128;

        let base = u128::from(base);

        let compounded =
            base.saturating_add(base.saturating_mul(percentage.into()).saturating_div(MAX));

        u64::try_from(compounded).ok()
    }
}

fn calculate_evm_swap_overhead(swap_type: &SwapType, swap_count: u8) -> Option<u64> {
    match swap_type {
        SwapType::TraderJoe(_) => TRADERJOE_GAS_OVERHEAD
            .checked_add(TRADERJOE_GAS_PER_SWAP.checked_mul(u64::from(swap_count))?),
        SwapType::UniswapV3(_) => UNISWAP_GAS_OVERHEAD
            .checked_add(UNISWAP_GAS_PER_SWAP.checked_mul(u64::from(swap_count))?),
        _ => None,
    }
}

fn calculate_evm_gas_cost(
    gas_price: u32,
    gas_price_margin: u32,
    total_gas: u64,
    native_token_price: u64,
) -> Option<u64> {
    // Using u128 to prevent overflow. If this calculation does overflow,
    // one of the inputs is grossly incorrect/misconfigured.
    let gas_cost = u128::from(total_gas)
        .checked_mul(u128::from(denormalize_gas_price(gas_price)))?
        .checked_mul(u128::from(native_token_price))?
        .saturating_div(u128::from(ONE_ETHER));

    compound(gas_price_margin, u64::try_from(gas_cost).ok()?)
}

fn calculate_gas_dropoff_cost(
    denorm_gas_dropoff: u64,
    gas_dropoff_margin: u32,
    native_token_price: u64,
) -> Option<u64> {
    // Using u128 to prevent overflow. If this calculation does overflow,
    // one of the inputs is grossly incorrect/misconfigured.
    let dropoff_cost = u128::from(denorm_gas_dropoff)
        .checked_mul(u128::from(native_token_price))?
        .saturating_div(u128::from(ONE_SOL));

    compound(gas_dropoff_margin, u64::try_from(dropoff_cost).ok()?)
}

pub fn calculate_relayer_fee(
    relay_params: &RelayParams,
    denorm_gas_dropoff: u64,
    swap_type: &SwapType,
    swap_count: u8,
) -> Result<u64> {
    require!(
        relay_params.base_fee != u32::MAX,
        SwapLayerError::RelayingDisabled
    );

    // Running sum of the relayer fee (USDC).
    let mut relayer_fee = u64::from(relay_params.base_fee);

    // Calculate the gas dropoff cost in USDC terms.
    if denorm_gas_dropoff > 0 {
        require!(
            denorm_gas_dropoff <= denormalize_gas_dropoff(relay_params.max_gas_dropoff),
            SwapLayerError::InvalidGasDropoff
        );

        relayer_fee += calculate_gas_dropoff_cost(
            denorm_gas_dropoff,
            relay_params.gas_dropoff_margin,
            relay_params.native_token_price,
        )
        .ok_or(SwapLayerError::GasDropoffCalculationFailed)?;
    }

    // Compute the relayer fee based on the cost of the relay in the
    // target execution environment's gas units (converted to USDC).
    let _ = match relay_params.execution_params {
        ExecutionParams::None => {
            err!(SwapLayerError::InvalidExecutionParams)
        }
        ExecutionParams::Evm {
            gas_price,
            gas_price_margin,
        } => {
            let mut total_gas = EVM_GAS_OVERHEAD;

            if denorm_gas_dropoff > 0 {
                total_gas += DROPOFF_GAS_OVERHEAD;
            }

            if swap_count > 0 {
                total_gas += calculate_evm_swap_overhead(swap_type, swap_count)
                    .ok_or(SwapLayerError::EvmGasCalculationFailed)?;
            }

            relayer_fee += calculate_evm_gas_cost(
                gas_price,
                gas_price_margin,
                total_gas,
                relay_params.native_token_price,
            )
            .ok_or(SwapLayerError::EvmGasCalculationFailed)?;

            Ok(())
        }
    };

    Ok(relayer_fee)
}

#[cfg(test)]
mod test {
    use swap_layer_messages::types::{
        TraderJoePoolId, TraderJoeSwapParameters, UniswapSwapParameters,
    };

    use crate::state::{ExecutionParams, RelayParams};

    use super::*;

    #[test]
    fn test_denormalize_gas_price() {
        let gas_price = 1_000; // 10 GWEI
        let denorm_gas_price = denormalize_gas_price(gas_price);

        assert_eq!(denorm_gas_price, 1_000_000_000);
    }

    #[test]
    fn test_compound() {
        let base = 1_000;
        let percentage = 500_000; // 50%
        let compounded = compound(percentage, base);

        assert_eq!(compounded, Some(1_500));
    }

    #[test]
    fn test_compound_max() {
        let base = 1_000;
        let percentage = 1_000_000; // 100%
        let compounded = compound(percentage, base);

        assert_eq!(compounded, Some(2_000));
    }

    #[test]
    fn test_zero_compound() {
        let base = 1_000;
        let percentage = 0;
        let compounded = compound(percentage, base);

        assert_eq!(compounded, Some(1_000));
    }

    #[test]
    fn test_uniswap_gas_overhead_one_swap() {
        let swap_type = &SwapType::UniswapV3(UniswapSwapParameters {
            first_leg_fee: 0.into(),
            path: vec![],
        });
        let swap_count = 1;
        let gas_overhead = calculate_evm_swap_overhead(swap_type, swap_count);

        assert_eq!(gas_overhead, Some(200_000));
    }

    #[test]
    fn test_uniswap_gas_overhead_three_swap() {
        let swap_type = &SwapType::UniswapV3(UniswapSwapParameters {
            first_leg_fee: 0.into(),
            path: vec![],
        });
        let swap_count = 3;
        let gas_overhead = calculate_evm_swap_overhead(swap_type, swap_count);

        assert_eq!(gas_overhead, Some(400_000));
    }

    #[test]
    fn test_traderjoe_gas_overhead_one_swap() {
        let swap_type = &SwapType::TraderJoe(TraderJoeSwapParameters {
            first_pool_id: TraderJoePoolId {
                version: 0,
                bin_size: 69,
            },
            path: vec![],
        });
        let swap_count = 1;
        let gas_overhead = calculate_evm_swap_overhead(swap_type, swap_count);

        assert_eq!(gas_overhead, Some(200_000));
    }

    #[test]
    fn test_traderjoe_gas_overhead_three_swap() {
        let swap_type = &SwapType::TraderJoe(TraderJoeSwapParameters {
            first_pool_id: TraderJoePoolId {
                version: 0,
                bin_size: 69,
            },
            path: vec![],
        });
        let swap_count = 3;
        let gas_overhead = calculate_evm_swap_overhead(swap_type, swap_count);

        assert_eq!(gas_overhead, Some(400_000));
    }

    #[test]
    fn test_calculate_evm_gas_cost() {
        let gas_price = 1_000; // 10 GWEI
        let gas_price_margin = 250_000; // 25%
        let total_gas = 100_000;
        let native_token_price = 200_000_000; // 200 USDC

        let gas_cost =
            calculate_evm_gas_cost(gas_price, gas_price_margin, total_gas, native_token_price);

        assert_eq!(gas_cost, Some(25_000));
    }

    #[test]
    fn test_calculate_gas_dropoff_cost() {
        let denorm_gas_dropoff = 500_000_000; // .5 SOL
        let gas_dropoff_margin = 500_000; // 50%
        let native_token_price = 200_000_000; // 200 USDC

        let dropoff_cost =
            calculate_gas_dropoff_cost(denorm_gas_dropoff, gas_dropoff_margin, native_token_price);

        assert_eq!(dropoff_cost, Some(150000000));
    }

    #[test]
    fn test_calculate_relayer_fee_no_swap() {
        let relay_params = test_relay_params();
        let denorm_gas_dropoff = 50_000_000;
        let swap_type = &SwapType::Invalid;
        let swap_count = 0;

        let relayer_fee =
            calculate_relayer_fee(&relay_params, denorm_gas_dropoff, swap_type, swap_count);

        assert_eq!(relayer_fee.unwrap(), 16775000);
    }

    #[test]
    fn test_calculate_relayer_fee_with_uniswap_swap() {
        let relay_params = test_relay_params();
        let denorm_gas_dropoff = 50_000_000;
        let swap_type = &SwapType::UniswapV3(UniswapSwapParameters {
            first_leg_fee: 0.into(),
            path: vec![],
        });
        let swap_count = 4;

        let relayer_fee =
            calculate_relayer_fee(&relay_params, denorm_gas_dropoff, swap_type, swap_count);

        assert_eq!(relayer_fee.unwrap(), 18025000);
    }

    #[test]
    fn test_calculate_relayer_fee_with_trader_joe_swap() {
        let relay_params = test_relay_params();
        let denorm_gas_dropoff = 50_000_000;
        let swap_type = &SwapType::TraderJoe(TraderJoeSwapParameters {
            first_pool_id: TraderJoePoolId {
                version: 0,
                bin_size: 69,
            },
            path: vec![],
        });
        let swap_count = 2;

        let relayer_fee =
            calculate_relayer_fee(&relay_params, denorm_gas_dropoff, swap_type, swap_count);

        assert_eq!(relayer_fee.unwrap(), 17525000);
    }

    // TODO: Add boundary tests.

    fn test_relay_params() -> RelayParams {
        RelayParams {
            base_fee: 1_500_000,             // 1.5 USDC
            native_token_price: 200_000_000, // 200 USDC
            max_gas_dropoff: 500_000,        // .5 SOL
            gas_dropoff_margin: 500_000,     // 50%
            execution_params: ExecutionParams::Evm {
                gas_price: 10_000,         // 10 GWEI
                gas_price_margin: 250_000, // 25%
            },
        }
    }
}