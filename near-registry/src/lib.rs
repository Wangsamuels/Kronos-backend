//! Kronos NEAR registry (`kronos.testnet`).
//!
//! * Registry of protected protocols: chain, guard address, approved package hash, status.
//! * Tighten-only monitor actions. The monitoring agent's NEAR account holds a **function-call access key**
//!   scoped to this contract and the single method `tighten` (zero deposit). It can pause a market or
//!   lower a cap / outflow threshold — never loosen anything, never move funds. Two independent layers
//!   enforce this:
//!     1. NEAR itself rejects any call with that key to a method other than `tighten`;
//!     2. `tighten` only accepts actions that make the protocol stricter than its current recorded state,
//!        and loosening methods (`unpause`, `raise_cap`, ...) reject monitor accounts outright.
//! * Every action is logged as a NEP-297 event so off-chain relayers (and, as a stretch goal, a Chain
//!   Signatures guardian) can apply it as a Tier 0 tighten on the EVM chain.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, IterableSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};
use std::collections::BTreeMap;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Monitors,
    Protocols,
    Actions,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Integrating,
    Live,
    Paused,
    Retired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Protocol {
    pub owner: AccountId,
    pub chain_id: U64,
    pub guard: String,
    pub package_hash: String,
    pub status: Status,
    /// markets paused by a tighten (market address -> paused). `"*"` means the whole protocol.
    pub paused: BTreeMap<String, bool>,
    /// lowest cap recorded per market (only ever lowered by tighten)
    pub caps: BTreeMap<String, U128>,
    /// outflow threshold per asset (only ever lowered by tighten)
    pub outflow_thresholds: BTreeMap<String, U128>,
    pub registered_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum TightenAction {
    Pause { market: Option<String> },
    LowerCap { market: String, new_cap: U128 },
    LowerOutflowThreshold { asset: String, new_threshold: U128 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ActionRecord {
    pub protocol_id: String,
    pub action: TightenAction,
    pub by: AccountId,
    pub reason: String,
    pub block_height: U64,
    pub timestamp_ms: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    monitors: IterableSet<AccountId>,
    protocols: IterableMap<String, Protocol>,
    actions: Vector<ActionRecord>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({ "standard": "kronos", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            monitors: IterableSet::new(Key::Monitors),
            protocols: IterableMap::new(Key::Protocols),
            actions: Vector::new(Key::Actions),
        }
    }

    // ------------------------------------------------------------------ admin

    pub fn add_monitor(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.monitors.insert(account_id.clone());
        emit("monitor_added", near_sdk::serde_json::json!({ "account_id": account_id }));
    }

    pub fn remove_monitor(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.monitors.remove(&account_id);
        emit("monitor_removed", near_sdk::serde_json::json!({ "account_id": account_id }));
    }

    // ------------------------------------------------------------------ protocol registry

    /// Registers a protected protocol. The caller becomes its owner (the protocol team's NEAR account).
    pub fn register_protocol(&mut self, protocol_id: String, chain_id: U64, guard: String, package_hash: String) {
        require!(!self.protocols.contains_key(&protocol_id), "protocol already registered");
        require!(guard.starts_with("0x") && guard.len() == 42, "guard must be a 0x EVM address");
        let p = Protocol {
            owner: env::predecessor_account_id(),
            chain_id,
            guard: guard.to_lowercase(),
            package_hash,
            status: Status::Integrating,
            paused: BTreeMap::new(),
            caps: BTreeMap::new(),
            outflow_thresholds: BTreeMap::new(),
            registered_at: U64(env::block_timestamp_ms()),
        };
        emit("protocol_registered", near_sdk::serde_json::json!({ "protocol_id": protocol_id, "chain_id": chain_id, "guard": p.guard }));
        self.protocols.insert(protocol_id, p);
    }

    /// Protocol owner: record a new approved package (e.g. after re-analysis) and mark it live.
    pub fn set_package(&mut self, protocol_id: String, package_hash: String, guard: String) {
        let p = self.owned(&protocol_id);
        p.package_hash = package_hash.clone();
        p.guard = guard.to_lowercase();
        p.status = Status::Live;
        emit("package_set", near_sdk::serde_json::json!({ "protocol_id": protocol_id, "package_hash": package_hash }));
    }

    pub fn set_status(&mut self, protocol_id: String, status: Status) {
        let p = self.owned(&protocol_id);
        p.status = status.clone();
        emit("status_set", near_sdk::serde_json::json!({ "protocol_id": protocol_id, "status": status }));
    }

    // ------------------------------------------------------------------ tighten-only

    /// The only method the monitor's function-call key may call. Accepts strictly-tightening actions.
    pub fn tighten(&mut self, protocol_id: String, action: TightenAction, reason: String) {
        let caller = env::predecessor_account_id();
        require!(env::attached_deposit().is_zero(), "no deposit");
        let is_monitor = self.monitors.contains(&caller);
        let mut p = self.protocols.get(&protocol_id).cloned().unwrap_or_else(|| env::panic_str("unknown protocol"));
        require!(is_monitor || caller == p.owner, "only a monitor or the protocol owner can tighten");
        match &action {
            TightenAction::Pause { market } => {
                let key = market.clone().unwrap_or_else(|| "*".to_string());
                p.paused.insert(key.clone(), true);
                if key == "*" {
                    p.status = Status::Paused;
                }
            }
            TightenAction::LowerCap { market, new_cap } => {
                if let Some(cur) = p.caps.get(&market.to_lowercase()) {
                    require!(new_cap.0 < cur.0, "not a tighten: new cap must be lower");
                }
                p.caps.insert(market.to_lowercase(), *new_cap);
            }
            TightenAction::LowerOutflowThreshold { asset, new_threshold } => {
                require!(new_threshold.0 > 0, "threshold must be positive");
                if let Some(cur) = p.outflow_thresholds.get(&asset.to_lowercase()) {
                    require!(new_threshold.0 < cur.0, "not a tighten: new threshold must be lower");
                }
                p.outflow_thresholds.insert(asset.to_lowercase(), *new_threshold);
            }
        }
        let rec = ActionRecord {
            protocol_id: protocol_id.clone(),
            action: action.clone(),
            by: caller,
            reason: reason.chars().take(200).collect(),
            block_height: U64(env::block_height()),
            timestamp_ms: U64(env::block_timestamp_ms()),
        };
        emit(
            "tighten",
            near_sdk::serde_json::json!({ "protocol_id": protocol_id, "chain_id": p.chain_id, "guard": p.guard, "action": action, "by": rec.by, "reason": rec.reason }),
        );
        self.protocols.insert(protocol_id, p);
        self.actions.push(rec);
    }

    // ------------------------------------------------------------------ loosening: protocol owner only

    pub fn unpause(&mut self, protocol_id: String, market: Option<String>) {
        require!(!self.monitors.contains(&env::predecessor_account_id()), "monitors can never loosen");
        let p = self.owned(&protocol_id);
        let key = market.unwrap_or_else(|| "*".to_string());
        p.paused.remove(&key);
        if key == "*" && p.status == Status::Paused {
            p.status = Status::Live;
        }
        emit("unpause", near_sdk::serde_json::json!({ "protocol_id": protocol_id, "market": key }));
    }

    pub fn raise_cap(&mut self, protocol_id: String, market: String, new_cap: U128) {
        require!(!self.monitors.contains(&env::predecessor_account_id()), "monitors can never loosen");
        let p = self.owned(&protocol_id);
        p.caps.insert(market.to_lowercase(), new_cap);
        emit("raise_cap", near_sdk::serde_json::json!({ "protocol_id": protocol_id, "market": market, "new_cap": new_cap }));
    }

    // ------------------------------------------------------------------ views

    pub fn get_protocol(&self, protocol_id: String) -> Option<Protocol> {
        self.protocols.get(&protocol_id).cloned()
    }

    pub fn list_protocols(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(String, Protocol)> {
        self.protocols
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get_actions(&self, protocol_id: Option<String>, from_index: Option<u32>, limit: Option<u32>) -> Vec<ActionRecord> {
        self.actions
            .iter()
            .filter(|a| protocol_id.as_ref().map_or(true, |p| &a.protocol_id == p))
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    pub fn is_monitor(&self, account_id: AccountId) -> bool {
        self.monitors.contains(&account_id)
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    // ------------------------------------------------------------------ internals

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the registry owner");
    }

    fn owned(&mut self, protocol_id: &String) -> &mut Protocol {
        let caller = env::predecessor_account_id();
        let p = self.protocols.get_mut(protocol_id).unwrap_or_else(|| env::panic_str("unknown protocol"));
        require!(p.owner == caller, "only the protocol owner");
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(who: AccountId) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(who).build());
    }

    fn setup() -> Registry {
        ctx(accounts(0));
        let mut r = Registry::new(accounts(0));
        r.add_monitor(accounts(2));
        ctx(accounts(1));
        r.register_protocol("minilend".into(), U64(1313161555), "0x00000000000000000000000000000000000000aA".into(), "0xhash".into());
        r
    }

    #[test]
    fn registers_protocol() {
        let r = setup();
        let p = r.get_protocol("minilend".into()).unwrap();
        assert_eq!(p.owner, accounts(1));
        assert_eq!(p.guard, "0x00000000000000000000000000000000000000aa");
        assert_eq!(p.status, Status::Integrating);
    }

    #[test]
    fn monitor_can_pause_and_lower() {
        let mut r = setup();
        ctx(accounts(2));
        r.tighten("minilend".into(), TightenAction::Pause { market: Some("0xthin".into()) }, "oracle anomaly".into());
        r.tighten("minilend".into(), TightenAction::LowerOutflowThreshold { asset: "0xUSDC".into(), new_threshold: U128(100) }, "split drain".into());
        r.tighten("minilend".into(), TightenAction::LowerOutflowThreshold { asset: "0xusdc".into(), new_threshold: U128(50) }, "again".into());
        let p = r.get_protocol("minilend".into()).unwrap();
        assert_eq!(p.paused.get("0xthin"), Some(&true));
        assert_eq!(p.outflow_thresholds.get("0xusdc"), Some(&U128(50)));
        assert_eq!(r.get_actions(Some("minilend".into()), None, None).len(), 3);
    }

    #[test]
    #[should_panic(expected = "not a tighten")]
    fn monitor_cannot_raise_threshold_via_tighten() {
        let mut r = setup();
        ctx(accounts(2));
        r.tighten("minilend".into(), TightenAction::LowerOutflowThreshold { asset: "0xusdc".into(), new_threshold: U128(100) }, "a".into());
        r.tighten("minilend".into(), TightenAction::LowerOutflowThreshold { asset: "0xusdc".into(), new_threshold: U128(1000) }, "b".into());
    }

    #[test]
    #[should_panic(expected = "monitors can never loosen")]
    fn monitor_cannot_unpause() {
        let mut r = setup();
        ctx(accounts(2));
        r.tighten("minilend".into(), TightenAction::Pause { market: None }, "x".into());
        r.unpause("minilend".into(), None);
    }

    #[test]
    #[should_panic(expected = "only a monitor or the protocol owner")]
    fn stranger_cannot_tighten() {
        let mut r = setup();
        ctx(accounts(3));
        r.tighten("minilend".into(), TightenAction::Pause { market: None }, "x".into());
    }

    #[test]
    fn owner_can_unpause() {
        let mut r = setup();
        ctx(accounts(2));
        r.tighten("minilend".into(), TightenAction::Pause { market: None }, "x".into());
        assert_eq!(r.get_protocol("minilend".into()).unwrap().status, Status::Paused);
        ctx(accounts(1));
        r.unpause("minilend".into(), None);
        assert_eq!(r.get_protocol("minilend".into()).unwrap().status, Status::Live);
    }
}
