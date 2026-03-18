module policy_kit::policy_registry {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use sui::table::{Self, Table};
    use std::string::String;

    /// Shared registry of policy templates
    public struct PolicyRegistry has key {
        id: UID,
        policies: Table<String, PolicyTemplate>,
    }

    public struct PolicyTemplate has store, copy, drop {
        name: String,
        max_slippage_bps: u64,
        per_action_limit_mist: u64,
        allowed_packages: vector<address>,
    }

    public fun init_registry(ctx: &mut TxContext) {
        let registry = PolicyRegistry {
            id: object::new(ctx),
            policies: table::new(ctx),
        };
        sui::transfer::share_object(registry);
    }

    public fun register_policy(
        registry: &mut PolicyRegistry,
        id: String,
        name: String,
        max_slippage_bps: u64,
        per_action_limit_mist: u64,
        allowed_packages: vector<address>,
    ) {
        table::add(&mut registry.policies, id, PolicyTemplate {
            name,
            max_slippage_bps,
            per_action_limit_mist,
            allowed_packages,
        });
    }

    public fun get_policy(registry: &PolicyRegistry, id: &String): &PolicyTemplate {
        table::borrow(&registry.policies, *id)
    }
}
