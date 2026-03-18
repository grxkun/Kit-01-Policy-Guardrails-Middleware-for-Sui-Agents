module policy_kit::session_key {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::clock::{Self, Clock};

    /// Owned by the agent. Represents a scoped session.
    public struct SessionKeyObject has key, store {
        id: UID,
        /// Ed25519 public key bytes of the ephemeral session key
        public_key: vector<u8>,
        /// Owner's Sui address
        owner: address,
        /// Expiry epoch timestamp in ms
        expires_at_ms: u64,
        /// Max SUI spend per action in MIST (0 = unlimited)
        per_action_limit_mist: u64,
        /// Allowed package IDs (empty = all allowed)
        allowed_packages: vector<address>,
        /// Whether session is active
        active: bool,
    }

    /// Create a new session key object
    public fun create(
        public_key: vector<u8>,
        ttl_ms: u64,
        per_action_limit_mist: u64,
        allowed_packages: vector<address>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): SessionKeyObject {
        SessionKeyObject {
            id: object::new(ctx),
            public_key,
            owner: tx_context::sender(ctx),
            expires_at_ms: clock::timestamp_ms(clock) + ttl_ms,
            per_action_limit_mist,
            allowed_packages,
            active: true,
        }
    }

    /// Revoke a session key (only owner)
    public fun revoke(session: &mut SessionKeyObject, ctx: &TxContext) {
        assert!(session.owner == tx_context::sender(ctx), 0);
        session.active = false;
    }

    /// Check if session is valid at current time
    public fun is_valid(session: &SessionKeyObject, clock: &Clock): bool {
        session.active && clock::timestamp_ms(clock) < session.expires_at_ms
    }

    public fun public_key(session: &SessionKeyObject): &vector<u8> { &session.public_key }
    public fun owner(session: &SessionKeyObject): address { session.owner }
    public fun per_action_limit_mist(session: &SessionKeyObject): u64 { session.per_action_limit_mist }
}
