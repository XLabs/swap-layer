use anchor_lang::prelude::*;

mod processor;
use processor::*;

mod composite;

mod error;

pub mod state;

pub mod utils;

declare_id!("AQFz751pSuxMX6PFWx9uruoVSZ3qay2Zi33MJ4NmUF2m");

const CUSTODIAN_BUMP: u8 = 255;
const SEED_PREFIX_COMPLETE: &[u8] = b"complete";
const MAX_BPS: u32 = 1_000_000; // 10,000.00 bps (100%)

#[program]
pub mod swap_layer {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        processor::initialize(ctx)
    }

    pub fn add_peer(ctx: Context<AddPeer>, args: AddPeerArgs) -> Result<()> {
        processor::add_peer(ctx, args)
    }

    pub fn update_peer(ctx: Context<UpdatePeer>, args: AddPeerArgs) -> Result<()> {
        processor::update_peer(ctx, args)
    }

    /// This instruction sets the `pending_owner` field in the `Custodian` account. This instruction
    /// can only be called by the `owner`. The `pending_owner` address must be valid, meaning it
    /// cannot be the zero address or the current owner.
    /// # Arguments
    ///
    /// * `ctx` - `SubmitOwnershipTransferRequest` context.
    pub fn submit_ownership_transfer_request(
        ctx: Context<SubmitOwnershipTransferRequest>,
    ) -> Result<()> {
        processor::submit_ownership_transfer_request(ctx)
    }

    /// This instruction confirms the ownership transfer request and sets the new `owner` in the
    /// `Custodian` account. This instruction can only be called by the `pending_owner`. The
    /// `pending_owner` must be the same as the `pending_owner` in the `Custodian` account.
    /// # Arguments
    ///
    /// * `ctx` - `ConfirmOwnershipTransferRequest` context.
    pub fn confirm_ownership_transfer_request(
        ctx: Context<ConfirmOwnershipTransferRequest>,
    ) -> Result<()> {
        processor::confirm_ownership_transfer_request(ctx)
    }

    /// This instruction cancels an ownership transfer request by resetting the `pending_owner` field
    /// in the `Custodian` account. This instruction can only be called by the `owner`.
    /// # Arguments
    ///
    /// * `ctx` - `CancelOwnershipTransferRequest` context.
    pub fn cancel_ownership_transfer_request(
        ctx: Context<CancelOwnershipTransferRequest>,
    ) -> Result<()> {
        processor::cancel_ownership_transfer_request(ctx)
    }

    /// This instruction is used to update the `fee_recipient` field in the `Custodian` account. This
    /// instruction can only be called by the `owner`.
    /// # Arguments
    ///
    /// * `ctx` - `UpdateFeeRecipient` context.
    pub fn update_fee_recipient(ctx: Context<UpdateFeeRecipient>) -> Result<()> {
        processor::update_fee_recipient(ctx)
    }

    /// This instruction is used to update the `owner_assistant` field in the `Custodian` account. This
    /// instruction can only be called by the `owner`.
    /// # Arguments
    ///
    /// * `ctx` - `UpdateOwnerAssistant` context.
    pub fn update_owner_assistant(ctx: Context<UpdateOwnerAssistant>) -> Result<()> {
        processor::update_owner_assistant(ctx)
    }

    pub fn update_fee_updater(ctx: Context<UpdateFeeUpdater>) -> Result<()> {
        processor::update_fee_updater(ctx)
    }

    pub fn update_relay_parameters(
        ctx: Context<UpdateRelayParameters>,
        args: UpdateRelayParametersArgs,
    ) -> Result<()> {
        processor::update_relay_parameters(ctx, args)
    }

    pub fn complete_transfer_relay(ctx: Context<CompleteTransferRelay>) -> Result<()> {
        processor::complete_transfer_relay(ctx)
    }

    pub fn complete_transfer_direct(ctx: Context<CompleteTransferDirect>) -> Result<()> {
        processor::complete_transfer_direct(ctx)
    }

    pub fn initiate_transfer(
        ctx: Context<InitiateTransfer>,
        args: InitiateTransferArgs,
    ) -> Result<()> {
        processor::initiate_transfer(ctx, args)
    }

    pub fn complete_swap<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, CompleteSwap<'info>>,
        ix_data: Vec<u8>,
    ) -> Result<()>
    where
        'c: 'info,
    {
        processor::complete_swap(ctx, ix_data)
    }
}