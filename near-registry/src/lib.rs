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
//! * Every action is logged as a NEP-297 event.
//! * **Chain Signatures.** `tighten` can also take `evm` transaction parameters. For an outflow tighten the
//!   contract itself builds the EIP-1559 transaction `guard.tightenOutflow(asset, newThreshold)` (target =
//!   the guard registered for that chain, value 0, bounded gas/fees), hashes it and asks NEAR's MPC signer
//!   for a signature under the path `kronos/<protocol_id>`. The derived EVM address holds the guard's
//!   `monitor` role, so one tighten-only NEAR key reaches every EVM chain, and it can only ever produce a
//!   tighten: the key cannot choose the target, the calldata or the value.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, IterableSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseOrValue};
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

/// EVM transaction parameters chosen by the monitor (everything else is fixed by the contract).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EvmTx {
    pub chain_id: U64,
    pub nonce: U64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: U64,
}

pub const DEFAULT_MPC_SIGNER: &str = "v1.signer-prod.testnet";
const MAX_EVM_GAS: u64 = 500_000;
const MAX_FEE_PER_GAS: u128 = 1_000_000_000_000; // 1000 gwei: bounds what a key can burn from the derived address

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
    pub fn tighten(&mut self, protocol_id: String, action: TightenAction, reason: String, evm: Option<EvmTx>) -> PromiseOrValue<bool> {
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
                // with an EVM leg the record is per chain ("<chain_id>:<asset>"): same asset address, different chains
                let key = match &evm {
                    Some(t) => format!("{}:{}", t.chain_id.0, asset.to_lowercase()),
                    None => asset.to_lowercase(),
                };
                if let Some(cur) = p.outflow_thresholds.get(&key) {
                    require!(new_threshold.0 < cur.0, "not a tighten: new threshold must be lower");
                }
                p.outflow_thresholds.insert(key, *new_threshold);
            }
        }
        if evm.is_some() {
            require!(matches!(action, TightenAction::LowerOutflowThreshold { .. }), "only outflow tightens have an EVM leg");
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
        let signed = evm.map(|t| {
            let TightenAction::LowerOutflowThreshold { asset, new_threshold } = &action else { unreachable!() };
            self.request_evm_signature(&protocol_id, &p, t, asset, new_threshold.0)
        });
        self.protocols.insert(protocol_id, p);
        self.actions.push(rec);
        match signed {
            Some(promise) => PromiseOrValue::Promise(promise),
            None => PromiseOrValue::Value(true),
        }
    }

    // ------------------------------------------------------------------ chain signatures

    /// Protocol owner: the guard address on another EVM chain (the registered `guard` covers `chain_id`).
    pub fn set_evm_guard(&mut self, protocol_id: String, chain_id: U64, guard: String) {
        require!(guard.starts_with("0x") && guard.len() == 42, "guard must be a 0x EVM address");
        self.owned(&protocol_id);
        let addr = parse_address(&guard);
        env::storage_write(&evm_guard_key(&protocol_id, chain_id.0), &addr);
        emit("evm_guard_set", near_sdk::serde_json::json!({ "protocol_id": protocol_id, "chain_id": chain_id, "guard": guard.to_lowercase() }));
    }

    /// Registry owner: MPC signer account and the deposit it requires per signature.
    pub fn set_mpc_signer(&mut self, account_id: AccountId, deposit_yocto: U128) {
        self.assert_owner();
        env::storage_write(b"cfg:signer", account_id.as_bytes());
        env::storage_write(b"cfg:sign_deposit", &deposit_yocto.0.to_le_bytes());
    }

    pub fn get_evm_guard(&self, protocol_id: String, chain_id: U64) -> Option<String> {
        let p = self.protocols.get(&protocol_id)?;
        self.evm_guard(&protocol_id, p, chain_id.0).map(|a| format!("0x{}", to_hex(&a)))
    }

    /// The MPC derivation path for a protocol's EVM monitor address (predecessor = this contract).
    pub fn mpc_path(&self, protocol_id: String) -> String {
        format!("kronos/{}", protocol_id)
    }

    pub fn mpc_signer(&self) -> AccountId {
        env::storage_read(b"cfg:signer")
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| DEFAULT_MPC_SIGNER.parse().unwrap())
    }

    /// Unsigned EIP-1559 transaction bytes (hex) the contract would sign for this tighten: lets anyone audit
    /// exactly what the MPC signature authorises.
    pub fn preview_evm_tighten(&self, protocol_id: String, asset: String, new_threshold: U128, evm: EvmTx) -> String {
        let p = self.protocols.get(&protocol_id).unwrap_or_else(|| env::panic_str("unknown protocol"));
        let to = self.evm_guard(&protocol_id, p, evm.chain_id.0).unwrap_or_else(|| env::panic_str("no guard registered for this chain"));
        to_hex(&unsigned_tightening_tx(&evm, &to, &parse_address(&asset), new_threshold.0))
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

    fn evm_guard(&self, protocol_id: &str, p: &Protocol, chain_id: u64) -> Option<[u8; 20]> {
        if let Some(b) = env::storage_read(&evm_guard_key(protocol_id, chain_id)) {
            let mut a = [0u8; 20];
            a.copy_from_slice(&b);
            return Some(a);
        }
        (p.chain_id.0 == chain_id).then(|| parse_address(&p.guard))
    }

    fn request_evm_signature(&self, protocol_id: &str, p: &Protocol, t: EvmTx, asset: &str, new_threshold: u128) -> Promise {
        require!(t.gas_limit.0 > 0 && t.gas_limit.0 <= MAX_EVM_GAS, "evm gas_limit out of bounds");
        require!(t.max_fee_per_gas.0 <= MAX_FEE_PER_GAS, "evm max_fee_per_gas out of bounds");
        require!(t.max_priority_fee_per_gas.0 <= t.max_fee_per_gas.0, "priority fee above max fee");
        let to = self.evm_guard(protocol_id, p, t.chain_id.0).unwrap_or_else(|| env::panic_str("no guard registered for this chain"));
        let tx = unsigned_tightening_tx(&t, &to, &parse_address(asset), new_threshold);
        let payload = env::keccak256_array(&tx);
        let path = format!("kronos/{}", protocol_id);
        emit(
            "evm_sign_request",
            near_sdk::serde_json::json!({
                "protocol_id": protocol_id, "chain_id": t.chain_id, "to": format!("0x{}", to_hex(&to)), "nonce": t.nonce,
                "payload": to_hex(&payload), "path": path, "unsigned_tx": to_hex(&tx)
            }),
        );
        let deposit = env::storage_read(b"cfg:sign_deposit")
            .map(|b| u128::from_le_bytes(b.try_into().unwrap_or([0; 16])))
            .unwrap_or(1);
        let args = near_sdk::serde_json::json!({ "request": { "payload_v2": { "Ecdsa": to_hex(&payload) }, "path": path, "domain_id": 0 } });
        Promise::new(self.mpc_signer()).function_call_weight(
            "sign".to_string(),
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(deposit),
            Gas::from_tgas(15),
            GasWeight(1),
        )
    }

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

// ------------------------------------------------------------------ EVM encoding (EIP-1559 + RLP)

fn evm_guard_key(protocol_id: &str, chain_id: u64) -> Vec<u8> {
    format!("eg:{}:{}", protocol_id, chain_id).into_bytes()
}

fn to_hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

fn parse_address(s: &str) -> [u8; 20] {
    let h = s.strip_prefix("0x").unwrap_or(s);
    require!(h.len() == 40, "address must be 20 bytes");
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("address is not hex"));
    }
    out
}

fn be_trimmed(v: u128) -> Vec<u8> {
    let b = v.to_be_bytes();
    let first = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    b[first..].to_vec()
}

fn rlp_len(prefix_short: u8, prefix_long: u8, len: usize) -> Vec<u8> {
    if len <= 55 {
        vec![prefix_short + len as u8]
    } else {
        let l = be_trimmed(len as u128);
        let mut v = vec![prefix_long + l.len() as u8];
        v.extend(l);
        v
    }
}

fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut v = rlp_len(0x80, 0xb7, b.len());
    v.extend_from_slice(b);
    v
}

fn rlp_uint(x: u128) -> Vec<u8> {
    rlp_bytes(&be_trimmed(x))
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.concat();
    let mut v = rlp_len(0xc0, 0xf7, body.len());
    v.extend(body);
    v
}

/// 0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gas, to, 0, tightenOutflow(asset, threshold), []])
fn unsigned_tightening_tx(t: &EvmTx, to: &[u8; 20], asset: &[u8; 20], new_threshold: u128) -> Vec<u8> {
    let mut data = env::keccak256_array(b"tightenOutflow(address,uint256)")[..4].to_vec();
    data.extend([0u8; 12]);
    data.extend_from_slice(asset);
    data.extend([0u8; 16]);
    data.extend(new_threshold.to_be_bytes());
    let mut out = vec![0x02];
    out.extend(rlp_list(&[
        rlp_uint(t.chain_id.0 as u128),
        rlp_uint(t.nonce.0 as u128),
        rlp_uint(t.max_priority_fee_per_gas.0),
        rlp_uint(t.max_fee_per_gas.0),
        rlp_uint(t.gas_limit.0 as u128),
        rlp_bytes(to),
        rlp_uint(0),
        rlp_bytes(&data),
        rlp_list(&[]),
    ]));
    out
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
        r.tighten("minilend".into(), TightenAction::Pause { market: Some("0xthin".into()) }, "oracle anomaly".into(), None);
        r.tighten("minilend".into(), TightenAction::LowerOutflowThreshold { asset: "0xUSDC".into(), new_threshold: U128(100) }, "split drain".into(), None);
        r.tighten("minilend".into(), TightenAction::LowerOutflowThreshold { asset: "0xusdc".into(), new_threshold: U128(50) }, "again".into(), None);
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
        r.tighten("minilend".into(), TightenAction::LowerOutflowThreshold { asset: "0xusdc".into(), new_threshold: U128(100) }, "a".into(), None);
        r.tighten("minilend".into(), TightenAction::LowerOutflowThreshold { asset: "0xusdc".into(), new_threshold: U128(1000) }, "b".into(), None);
    }

    #[test]
    #[should_panic(expected = "monitors can never loosen")]
    fn monitor_cannot_unpause() {
        let mut r = setup();
        ctx(accounts(2));
        r.tighten("minilend".into(), TightenAction::Pause { market: None }, "x".into(), None);
        r.unpause("minilend".into(), None);
    }

    #[test]
    #[should_panic(expected = "only a monitor or the protocol owner")]
    fn stranger_cannot_tighten() {
        let mut r = setup();
        ctx(accounts(3));
        r.tighten("minilend".into(), TightenAction::Pause { market: None }, "x".into(), None);
    }

    #[test]
    fn owner_can_unpause() {
        let mut r = setup();
        ctx(accounts(2));
        r.tighten("minilend".into(), TightenAction::Pause { market: None }, "x".into(), None);
        assert_eq!(r.get_protocol("minilend".into()).unwrap().status, Status::Paused);
        ctx(accounts(1));
        r.unpause("minilend".into(), None);
        assert_eq!(r.get_protocol("minilend".into()).unwrap().status, Status::Live);
    }

    fn evm(chain: u64) -> EvmTx {
        EvmTx { chain_id: U64(chain), nonce: U64(7), max_priority_fee_per_gas: U128(1_000_000), max_fee_per_gas: U128(70_000_000), gas_limit: U64(120_000) }
    }

    #[test]
    fn evm_tighten_is_per_chain_and_preview_matches_rlp() {
        let mut r = setup();
        ctx(accounts(1));
        r.set_evm_guard("minilend".into(), U64(84532), "0x00000000000000000000000000000000000000bB".into());
        assert_eq!(r.get_evm_guard("minilend".into(), U64(84532)).unwrap(), "0x00000000000000000000000000000000000000bb");
        assert_eq!(r.get_evm_guard("minilend".into(), U64(1313161555)).unwrap(), "0x00000000000000000000000000000000000000aa");
        let tx = r.preview_evm_tighten("minilend".into(), "0x00000000000000000000000000000000000000cc".into(), U128(500), evm(84532));
        assert!(tx.starts_with("02"));
        assert!(tx.contains("00000000000000000000000000000000000000bb")); // target = that chain's guard
        ctx(accounts(2));
        let a = TightenAction::LowerOutflowThreshold { asset: "0x00000000000000000000000000000000000000cc".into(), new_threshold: U128(500) };
        r.tighten("minilend".into(), a.clone(), "x".into(), Some(evm(84532)));
        r.tighten("minilend".into(), a, "x".into(), Some(evm(1313161555))); // same value, other chain: allowed
        let p = r.get_protocol("minilend".into()).unwrap();
        assert_eq!(p.outflow_thresholds.get("84532:0x00000000000000000000000000000000000000cc"), Some(&U128(500)));
    }

    #[test]
    #[should_panic(expected = "only outflow tightens have an EVM leg")]
    fn pause_has_no_evm_leg() {
        let mut r = setup();
        ctx(accounts(2));
        r.tighten("minilend".into(), TightenAction::Pause { market: None }, "x".into(), Some(evm(1313161555)));
    }

    #[test]
    #[should_panic(expected = "no guard registered for this chain")]
    fn unknown_chain_rejected() {
        let mut r = setup();
        ctx(accounts(2));
        let a = TightenAction::LowerOutflowThreshold { asset: "0x00000000000000000000000000000000000000cc".into(), new_threshold: U128(5) };
        r.tighten("minilend".into(), a, "x".into(), Some(evm(1)));
    }

    #[test]
    #[should_panic(expected = "evm max_fee_per_gas out of bounds")]
    fn fee_cap_enforced() {
        let mut r = setup();
        ctx(accounts(2));
        let mut t = evm(1313161555);
        t.max_fee_per_gas = U128(MAX_FEE_PER_GAS + 1);
        let a = TightenAction::LowerOutflowThreshold { asset: "0x00000000000000000000000000000000000000cc".into(), new_threshold: U128(5) };
        r.tighten("minilend".into(), a, "x".into(), Some(t));
    }

    #[test]
    #[should_panic(expected = "only the protocol owner")]
    fn stranger_cannot_set_evm_guard() {
        let mut r = setup();
        ctx(accounts(3));
        r.set_evm_guard("minilend".into(), U64(84532), "0x00000000000000000000000000000000000000bB".into());
    }
}
