use anchor_lang::prelude::*;

// Placeholder. Run `anchor keys sync` after the first build and this is
// rewritten with the real program id (it also updates Anchor.toml).
declare_id!("SigPath111111111111111111111111111111111111");

/// SigPath — the on-chain half of a dual-chain attestation registry.
///
/// WHAT LIVES WHERE
/// Solana is the source of truth: attestations are created, scored and revoked
/// here, because it is cheap enough to write per-subject records and fast enough
/// that a revocation is visible to every verifier within a slot.
/// Base (EAS) is a MIRROR: `base_uid` stores the EAS attestation UID so the same
/// claim is portable to EVM consumers. The mirror is optional — a zeroed
/// `base_uid` means "Solana only", and nothing here depends on Base being up.
///
/// WHY REVOKE RATHER THAN CLOSE
/// A revoked attestation keeps its account and flips a flag. Closing it would
/// make a revoked record indistinguishable from one that never existed, which
/// is exactly the ambiguity an attacker wants. Verifiers must be able to see
/// "this was attested, and then withdrawn".
#[program]
pub mod sigpath {
    use super::*;

    /// Record an attestation about a subject.
    ///
    /// `subject_hash` is a 32-byte commitment to whatever the attestation is
    /// about — a wallet, a hashed account handle, a business identifier. Hashing
    /// it keeps personal identifiers off-chain while still giving a stable,
    /// re-derivable address: anyone who knows the subject can find the record by
    /// re-hashing it, and anyone who doesn't learns nothing.
    pub fn issue(
        ctx: Context<Issue>,
        subject_hash: [u8; 32],
        score: u8,
        method: u8,
        base_uid: [u8; 32],
        ttl_seconds: i64,
    ) -> Result<()> {
        require!(score <= 100, SigPathError::ScoreOutOfRange);

        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts.attestation;

        a.subject_hash = subject_hash;
        a.issuer = ctx.accounts.issuer.key();
        a.score = score;
        a.method = method;
        a.base_uid = base_uid;
        a.issued_at = now;
        // 0 = never expires. Otherwise the attestation reads as stale after this.
        a.expires_at = if ttl_seconds > 0 { now + ttl_seconds } else { 0 };
        a.revoked = 0;
        a.bump = ctx.bumps.attestation;

        emit!(Attested {
            subject_hash,
            issuer: a.issuer,
            score,
            method,
            issued_at: now,
        });
        Ok(())
    }

    /// Withdraw an attestation. Only the original issuer may do this — an
    /// attestation is the issuer's claim, so nobody else can retract it.
    pub fn revoke(ctx: Context<Revoke>, _subject_hash: [u8; 32]) -> Result<()> {
        let a = &mut ctx.accounts.attestation;
        require_keys_eq!(a.issuer, ctx.accounts.issuer.key(), SigPathError::NotIssuer);
        a.revoked = 1;

        emit!(Revoked {
            subject_hash: a.subject_hash,
            issuer: a.issuer,
            revoked_at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Attach or update the Base/EAS mirror UID after the EVM write lands.
    ///
    /// Separate from `issue` on purpose: the Solana write must not block on an
    /// EVM transaction. Issue first, mirror second, link when it confirms.
    pub fn link_base(ctx: Context<LinkBase>, _subject_hash: [u8; 32], base_uid: [u8; 32]) -> Result<()> {
        let a = &mut ctx.accounts.attestation;
        require_keys_eq!(a.issuer, ctx.accounts.issuer.key(), SigPathError::NotIssuer);
        a.base_uid = base_uid;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Attestation {
    /// 32-byte commitment to the subject. PDA seed.
    pub subject_hash: [u8; 32],
    /// Who made this claim. The liability record.
    pub issuer: Pubkey,
    /// 0..100.
    pub score: u8,
    /// Bitfield describing HOW the score was reached, so a verifier can weigh it
    /// rather than taking a bare number on trust. See the METHOD_* constants.
    pub method: u8,
    /// EAS attestation UID on Base. Zeroed when not mirrored.
    pub base_uid: [u8; 32],
    pub issued_at: i64,
    /// 0 = never expires.
    pub expires_at: i64,
    pub revoked: u8,
    pub bump: u8,
}

impl Attestation {
    pub const SIZE: usize = 8  // discriminator
        + 32  // subject_hash
        + 32  // issuer
        + 1   // score
        + 1   // method
        + 32  // base_uid
        + 8   // issued_at
        + 8   // expires_at
        + 1   // revoked
        + 1; // bump

    pub fn is_live(&self, now: i64) -> bool {
        self.revoked == 0 && (self.expires_at == 0 || now <= self.expires_at)
    }
}

/// Method bitfield. Combine with `|`. A verifier that only trusts corroborated
/// evidence can require METHOD_CORROBORATED to be set and ignore the rest.
pub const METHOD_SELF_ASSERTED: u8 = 1 << 0;
pub const METHOD_OWNERSHIP_PROVEN: u8 = 1 << 1;
pub const METHOD_CORROBORATED: u8 = 1 << 2;
pub const METHOD_LIVE_CAPTURE: u8 = 1 << 3;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(subject_hash: [u8; 32])]
pub struct Issue<'info> {
    #[account(
        init,
        payer = issuer,
        space = Attestation::SIZE,
        seeds = [b"attest", subject_hash.as_ref()],
        bump
    )]
    pub attestation: Account<'info, Attestation>,
    #[account(mut)]
    pub issuer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject_hash: [u8; 32])]
pub struct Revoke<'info> {
    #[account(
        mut,
        seeds = [b"attest", subject_hash.as_ref()],
        bump = attestation.bump
    )]
    pub attestation: Account<'info, Attestation>,
    pub issuer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(subject_hash: [u8; 32])]
pub struct LinkBase<'info> {
    #[account(
        mut,
        seeds = [b"attest", subject_hash.as_ref()],
        bump = attestation.bump
    )]
    pub attestation: Account<'info, Attestation>,
    pub issuer: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct Attested {
    pub subject_hash: [u8; 32],
    pub issuer: Pubkey,
    pub score: u8,
    pub method: u8,
    pub issued_at: i64,
}

#[event]
pub struct Revoked {
    pub subject_hash: [u8; 32],
    pub issuer: Pubkey,
    pub revoked_at: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum SigPathError {
    #[msg("Score must be between 0 and 100.")]
    ScoreOutOfRange,
    #[msg("Only the original issuer may modify this attestation.")]
    NotIssuer,
}
