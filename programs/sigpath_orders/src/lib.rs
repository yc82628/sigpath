use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;

declare_id!("3gWtrK2mxrW5udZuYxQaeAKwTFx2VbD8WfShBMpgHBwW");

/// SigPath Orders — USDC escrow for purchases made on a shopper's behalf.
///
/// THE PROBLEM THIS SOLVES
/// Amazon, eBay and Etsy do not accept USDC. When a shopper pays on SigPath,
/// SigPath buys the item on the retailer's site and ships it to them. That
/// spares the shopper typing a card number into every site they buy from, but it
/// asks them to hand money to SigPath instead. "Why would I send my USDC to a
/// website?" is the right question, and this program is the answer:
///
///   - The USDC is held in a vault that only this PROGRAM can sign for. Not the
///     operator, not the shopper, not anyone holding a key.
///   - It is released to the operator only by `fulfil`, and only BEFORE the
///     order's deadline.
///   - After the deadline, `refund` returns it to the buyer. ANYONE can call
///     refund once the deadline has passed, so no one can stop it, and it can
///     only pay out to the buyer's own USDC account.
///
/// The rules are code, readable by anyone, rather than a promise in a terms of
/// service. That is the same principle as the rest of SigPath: policy lives
/// somewhere it cannot be talked out of.
///
/// WHAT THIS DOES NOT PROVE — SAY THIS BEFORE A JUDGE DOES
/// A blockchain cannot see a parcel arrive. `fulfil` records a 32-byte
/// commitment to the retailer's order or tracking reference, which the buyer can
/// check and dispute, but the program has to take the operator's word that the
/// purchase happened. What the escrow guarantees is narrower and still worth a
/// lot: if the operator does NOTHING, the buyer gets every cent back
/// automatically. Resolving "the operator claims it shipped and it did not"
/// needs an arbiter, which is the next design step, not something to pretend
/// this already does.
///
/// DEVNET CONSTANTS
/// The operator and the accepted mint are constants rather than a config
/// account, so the deployed code itself states who can be paid and in what. A
/// mainnet deployment would move these into an admin-controlled config account.
#[program]
pub mod sigpath_orders {
    use super::*;

    /// Buyer funds an order. Creates the order record and its vault, and moves
    /// `amount` USDC from the buyer into the vault in the same transaction.
    ///
    /// `nonce` makes the order address unique per buyer (the client uses a
    /// timestamp). `listing_hash` is a 32-byte commitment to exactly what was
    /// bought — the listing's source, id and URL, hashed — so the order cannot
    /// later be claimed to have been for something else.
    pub fn create_order(
        ctx: Context<CreateOrder>,
        nonce: u64,
        amount: u64,
        listing_hash: [u8; 32],
        window_secs: i64,
    ) -> Result<()> {
        require!(amount > 0, OrdersError::ZeroAmount);
        require!(amount <= MAX_AMOUNT, OrdersError::AmountTooLarge);
        require!(
            (MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&window_secs),
            OrdersError::WindowOutOfRange
        );

        let order_key = ctx.accounts.order.key();
        let vault_bump = ctx.bumps.vault;
        let vault_seeds: &[&[u8]] = &[b"vault", order_key.as_ref(), &[vault_bump]];

        let token_program = ctx.accounts.token_program.to_account_info();
        let mint = ctx.accounts.mint.to_account_info();
        let vault = ctx.accounts.vault.to_account_info();

        // The vault is a plain SPL token account at a program-derived address,
        // owned (in the token sense) by the ORDER account. Only this program
        // can produce the order's signature, so only this program can move it.
        let lamports = Rent::get()?.minimum_balance(TOKEN_ACCOUNT_LEN);
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: vault.clone(),
                },
                &[vault_seeds],
            ),
            lamports,
            TOKEN_ACCOUNT_LEN as u64,
            &TOKEN_PROGRAM_ID,
        )?;
        token_initialize_account3(&token_program, &vault, &mint, &order_key)?;

        // TransferChecked makes the token program itself verify the mint and
        // decimals of both accounts and that the buyer signed as owner.
        token_transfer_checked(
            &token_program,
            &ctx.accounts.buyer_token.to_account_info(),
            &mint,
            &vault,
            &ctx.accounts.buyer.to_account_info(),
            amount,
            &[],
        )?;

        let now = Clock::get()?.unix_timestamp;
        let o = &mut ctx.accounts.order;
        o.buyer = ctx.accounts.buyer.key();
        o.nonce = nonce;
        o.amount = amount;
        o.listing_hash = listing_hash;
        o.created_at = now;
        o.deadline = now + window_secs;
        o.status = STATUS_FUNDED;
        o.fulfilment_ref = [0u8; 32];
        o.settled_at = 0;
        o.bump = ctx.bumps.order;
        o.vault_bump = vault_bump;

        emit!(OrderCreated {
            order: order_key,
            buyer: o.buyer,
            amount,
            listing_hash,
            deadline: o.deadline,
        });
        Ok(())
    }

    /// Operator marks the order fulfilled and is paid.
    ///
    /// Only before the deadline: after it, the buyer is entitled to a refund and
    /// a late fulfilment cannot race them for the funds. `fulfilment_ref` is a
    /// hash of the retailer's order confirmation or tracking number — a public
    /// commitment the buyer can check against what actually arrives.
    pub fn fulfil(ctx: Context<Fulfil>, fulfilment_ref: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (buyer, nonce, bump, amount, status, deadline) = {
            let o = &ctx.accounts.order;
            (o.buyer, o.nonce, o.bump, o.amount, o.status, o.deadline)
        };
        require!(status == STATUS_FUNDED, OrdersError::NotFunded);
        require!(now <= deadline, OrdersError::DeadlinePassed);
        require!(fulfilment_ref != [0u8; 32], OrdersError::MissingFulfilmentRef);

        let nonce_bytes = nonce.to_le_bytes();
        let order_seeds: &[&[u8]] = &[b"order", buyer.as_ref(), &nonce_bytes, &[bump]];

        let token_program = ctx.accounts.token_program.to_account_info();
        let mint = ctx.accounts.mint.to_account_info();
        let vault = ctx.accounts.vault.to_account_info();
        let order_ai = ctx.accounts.order.to_account_info();

        // Exactly the order amount to the operator.
        token_transfer_checked(
            &token_program,
            &vault,
            &mint,
            &ctx.accounts.operator_token.to_account_info(),
            &order_ai,
            amount,
            &[order_seeds],
        )?;

        // Close the vault and return its rent to the buyer, who paid it — but
        // only if it is now empty. A third party can send extra USDC to the
        // vault address; CloseAccount would then fail, and failing HERE would
        // lock the order forever. So an unexpected balance is simply left in
        // the vault: the order still settles, the extra is the sender's own
        // loss, and the buyer forgoes only the vault's rent deposit.
        if token_account_balance(&vault)? == 0 {
            token_close_account(
                &token_program,
                &vault,
                &ctx.accounts.buyer.to_account_info(),
                &order_ai,
                &[order_seeds],
            )?;
        }

        let o = &mut ctx.accounts.order;
        o.status = STATUS_FULFILLED;
        o.fulfilment_ref = fulfilment_ref;
        o.settled_at = now;

        emit!(OrderFulfilled {
            order: o.key(),
            amount,
            fulfilment_ref,
        });
        Ok(())
    }

    /// Return the funds to the buyer.
    ///
    /// Allowed when EITHER the deadline has passed — and then anyone may call
    /// it, so a refund cannot be withheld — OR the operator calls it early
    /// (item unavailable, price changed). The destination is checked to be the
    /// buyer's own USDC account; without that check, a stranger calling a
    /// permissionless refund could route the buyer's money to themselves.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (buyer, nonce, bump, status, deadline) = {
            let o = &ctx.accounts.order;
            (o.buyer, o.nonce, o.bump, o.status, o.deadline)
        };
        require!(status == STATUS_FUNDED, OrdersError::NotFunded);
        let by_operator = ctx.accounts.caller.key() == OPERATOR;
        require!(by_operator || now > deadline, OrdersError::DeadlineNotReached);

        let dest = read_token_account(&ctx.accounts.buyer_token.to_account_info())?;
        require_keys_eq!(dest.mint, USDC_MINT, OrdersError::WrongMint);
        require_keys_eq!(dest.owner, buyer, OrdersError::RefundNotToBuyer);

        let nonce_bytes = nonce.to_le_bytes();
        let order_seeds: &[&[u8]] = &[b"order", buyer.as_ref(), &nonce_bytes, &[bump]];

        let token_program = ctx.accounts.token_program.to_account_info();
        let mint = ctx.accounts.mint.to_account_info();
        let vault = ctx.accounts.vault.to_account_info();
        let order_ai = ctx.accounts.order.to_account_info();

        // The WHOLE vault balance, not `amount`: anything extra sent to the
        // vault belongs to nobody else, and leaving it behind would make the
        // close below fail and strand the refund.
        let balance = token_account_balance(&vault)?;
        if balance > 0 {
            token_transfer_checked(
                &token_program,
                &vault,
                &mint,
                &ctx.accounts.buyer_token.to_account_info(),
                &order_ai,
                balance,
                &[order_seeds],
            )?;
        }
        token_close_account(
            &token_program,
            &vault,
            &ctx.accounts.buyer.to_account_info(),
            &order_ai,
            &[order_seeds],
        )?;

        let o = &mut ctx.accounts.order;
        o.status = STATUS_REFUNDED;
        o.settled_at = now;

        emit!(OrderRefunded {
            order: o.key(),
            amount: balance,
            by_operator,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The only key that can fulfil (and so be paid for) an order.
pub const OPERATOR: Pubkey = pubkey!("AaFcCzgJ53SPpqheu8KGM6fA3i4cwd57SL8goz6jdfXg");
/// Circle's devnet USDC. The only mint this program accepts.
pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
/// Classic SPL Token. Devnet USDC is not a Token-2022 mint.
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const USDC_DECIMALS: u8 = 6;

/// Shortest fulfilment window. Short enough to test the refund path on devnet
/// in a minute; a real storefront would use days.
pub const MIN_WINDOW_SECS: i64 = 60;
/// Longest window a buyer's money can be held for.
pub const MAX_WINDOW_SECS: i64 = 30 * 24 * 3600;
/// Per-order ceiling: 1,000 USDC. A devnet safety rail, not a business rule.
pub const MAX_AMOUNT: u64 = 1_000 * 1_000_000;

pub const STATUS_FUNDED: u8 = 0;
pub const STATUS_FULFILLED: u8 = 1;
pub const STATUS_REFUNDED: u8 = 2;

/// Size of an SPL token account.
const TOKEN_ACCOUNT_LEN: usize = 165;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateOrder<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        init,
        payer = buyer,
        space = 8 + Order::INIT_SPACE,
        seeds = [b"order", buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, Order>,

    /// CHECK: created in the handler as an SPL token account at this PDA. The
    /// seeds constraint pins the address, so a substitute cannot be passed.
    #[account(mut, seeds = [b"vault", order.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: the buyer's USDC account. TransferChecked has the token program
    /// verify its mint, and that `buyer` signed as its owner.
    #[account(mut)]
    pub buyer_token: UncheckedAccount<'info>,

    /// CHECK: pinned to devnet USDC.
    #[account(address = USDC_MINT)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: pinned to the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fulfil<'info> {
    #[account(address = OPERATOR @ OrdersError::NotOperator)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        has_one = buyer,
        seeds = [b"order", order.buyer.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,

    /// CHECK: receives the vault's rent; must be the order's buyer (has_one).
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,

    /// CHECK: pinned by seeds to this order's vault.
    #[account(mut, seeds = [b"vault", order.key().as_ref()], bump = order.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: where the operator is paid. TransferChecked verifies the mint;
    /// the operator signs, so the destination is theirs to choose.
    #[account(mut)]
    pub operator_token: UncheckedAccount<'info>,

    /// CHECK: pinned to devnet USDC.
    #[account(address = USDC_MINT)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: pinned to the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Anyone, once the deadline has passed; only the operator before it.
    pub caller: Signer<'info>,

    #[account(
        mut,
        has_one = buyer,
        seeds = [b"order", order.buyer.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,

    /// CHECK: receives the vault's rent; must be the order's buyer (has_one).
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,

    /// CHECK: parsed and checked in the handler to be a USDC account OWNED BY
    /// THE BUYER. This is the check that stops a permissionless refund being
    /// routed to whoever called it.
    #[account(mut)]
    pub buyer_token: UncheckedAccount<'info>,

    /// CHECK: pinned by seeds to this order's vault.
    #[account(mut, seeds = [b"vault", order.key().as_ref()], bump = order.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: pinned to devnet USDC.
    #[account(address = USDC_MINT)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: pinned to the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// One purchase. Kept after settlement as a public receipt: who paid, how
/// much, for which listing, and how it ended — fulfilled with a reference, or
/// refunded.
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub buyer: Pubkey,
    pub nonce: u64,
    /// USDC base units (6 decimals).
    pub amount: u64,
    pub listing_hash: [u8; 32],
    pub created_at: i64,
    pub deadline: i64,
    pub status: u8,
    /// Hash of the retailer order / tracking reference. Zero until fulfilled.
    pub fulfilment_ref: [u8; 32],
    pub settled_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct OrderCreated {
    pub order: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub listing_hash: [u8; 32],
    pub deadline: i64,
}

#[event]
pub struct OrderFulfilled {
    pub order: Pubkey,
    pub amount: u64,
    pub fulfilment_ref: [u8; 32],
}

#[event]
pub struct OrderRefunded {
    pub order: Pubkey,
    pub amount: u64,
    pub by_operator: bool,
}

// ---------------------------------------------------------------------------
// Errors — codes start at 6000, in this order. lib/chains/solana/orders.ts
// mirrors this list; keep the two in the same order.
// ---------------------------------------------------------------------------

#[error_code]
pub enum OrdersError {
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Amount exceeds the per-order limit.")]
    AmountTooLarge,
    #[msg("Fulfilment window is out of range.")]
    WindowOutOfRange,
    #[msg("Order is not awaiting fulfilment.")]
    NotFunded,
    #[msg("The fulfilment deadline has passed; only a refund is possible.")]
    DeadlinePassed,
    #[msg("The fulfilment deadline has not passed yet.")]
    DeadlineNotReached,
    #[msg("A fulfilment reference is required.")]
    MissingFulfilmentRef,
    #[msg("Refunds may only go to the buyer's own USDC account.")]
    RefundNotToBuyer,
    #[msg("Not a valid SPL token account.")]
    InvalidTokenAccount,
    #[msg("Wrong mint.")]
    WrongMint,
    #[msg("Only the SigPath operator can do that.")]
    NotOperator,
}

// ---------------------------------------------------------------------------
// Hand-built SPL Token CPIs — see Cargo.toml for why there is no anchor-spl.
// Instruction indices are from the SPL Token program's instruction enum.
// ---------------------------------------------------------------------------

/// TransferChecked = 12: [12, amount u64 LE, decimals u8].
/// Accounts: source (w), mint (r), destination (w), authority (signer).
fn token_transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(10);
    data.push(12u8);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(USDC_DECIMALS);
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[from.clone(), mint.clone(), to.clone(), authority.clone(), token_program.clone()],
        signer_seeds,
    )?;
    Ok(())
}

/// InitializeAccount3 = 18: [18, owner pubkey (32)]. Accounts: account (w), mint (r).
fn token_initialize_account3<'info>(
    token_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &Pubkey,
) -> Result<()> {
    let mut data = Vec::with_capacity(33);
    data.push(18u8);
    data.extend_from_slice(owner.as_ref());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account.key, false),
            AccountMeta::new_readonly(*mint.key, false),
        ],
        data,
    };
    invoke_signed(&ix, &[account.clone(), mint.clone(), token_program.clone()], &[])?;
    Ok(())
}

/// CloseAccount = 9: [9]. Accounts: account (w), destination (w), owner (signer).
fn token_close_account<'info>(
    token_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*owner.key, true),
        ],
        data: vec![9u8],
    };
    invoke_signed(
        &ix,
        &[account.clone(), destination.clone(), owner.clone(), token_program.clone()],
        signer_seeds,
    )?;
    Ok(())
}

struct TokenAccountView {
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
}

/// Parse an SPL token account by its fixed layout:
///   mint [0..32] | owner [32..64] | amount [64..72] | delegate [72..108]
///   | state [108] | ... (165 bytes total)
///
/// The ownership check comes first and is the one that matters: without it,
/// any program could fabricate 165 bytes claiming to be the buyer's account.
fn read_token_account(ai: &AccountInfo) -> Result<TokenAccountView> {
    require_keys_eq!(*ai.owner, TOKEN_PROGRAM_ID, OrdersError::InvalidTokenAccount);
    let data = ai.try_borrow_data()?;
    require!(data.len() == TOKEN_ACCOUNT_LEN, OrdersError::InvalidTokenAccount);
    // state: 0 uninitialised, 1 initialised, 2 frozen. Only 1 can receive.
    require!(data[108] == 1, OrdersError::InvalidTokenAccount);
    let mint = Pubkey::try_from(&data[0..32]).map_err(|_| error!(OrdersError::InvalidTokenAccount))?;
    let owner = Pubkey::try_from(&data[32..64]).map_err(|_| error!(OrdersError::InvalidTokenAccount))?;
    let amount = u64::from_le_bytes(
        data[64..72]
            .try_into()
            .map_err(|_| error!(OrdersError::InvalidTokenAccount))?,
    );
    Ok(TokenAccountView { mint, owner, amount })
}

fn token_account_balance(ai: &AccountInfo) -> Result<u64> {
    Ok(read_token_account(ai)?.amount)
}
