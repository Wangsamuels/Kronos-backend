// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {KronosGuard} from "../src/KronosGuard.sol";
import {GuardTimelock} from "../src/GuardTimelock.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {GuardedMiniLend} from "../src/samples/GuardedMiniLend.sol";
import {MiniLend} from "../src/samples/MiniLend.sol";
import {MiniLendCore} from "../src/samples/MiniLendCore.sol";
import {MockERC20, MockPriceOracle, MockAMMOracle} from "../src/mocks/Mocks.sol";

/// Deploys the full Kronos demo to a testnet (Aurora testnet or Base Sepolia):
///   tokens + oracles, AttestationRegistry, GuardTimelock, GuardedMiniLend (and the unguarded MiniLend for
///   side-by-side attack replays), installs the tier table, bootstraps listings, then closes setup.
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url aurora_testnet --broadcast --legacy
/// Env: DEPLOYER_PRIVATE_KEY (required); ATTESTOR_ADDRESS, GUARDIAN_ADDRESS, MONITOR_ADDRESS (default: deployer);
///      KRONOS_CONFIG (optional path to an approved package's kronos.config.json)
contract Deploy is Script {
    struct Out {
        address usdc;
        address weth;
        address thin;
        address fixedOracle;
        address thinPool;
        address registry;
        address timelock;
        address guardedMiniLend;
        address miniLend;
    }

    uint256 internal pk;
    address internal me;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockERC20 internal thin;
    MockPriceOracle internal fixedOracle;
    MockAMMOracle internal pool;
    GuardTimelock internal timelock;
    AttestationRegistry internal registry;
    GuardedMiniLend internal lend;
    MiniLend internal plain;

    function run() external returns (Out memory o) {
        pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        me = vm.addr(pk);
        vm.startBroadcast(pk);
        _tokens();
        _core();
        _bootstrap();
        _seed();
        vm.stopBroadcast();
        o = Out(
            address(usdc),
            address(weth),
            address(thin),
            address(fixedOracle),
            address(pool),
            address(registry),
            address(timelock),
            address(lend),
            address(plain)
        );
        _write(o);
    }

    function _tokens() internal {
        usdc = new MockERC20("Kronos USD", "kUSDC", 6);
        weth = new MockERC20("Kronos WETH", "kWETH", 18);
        thin = new MockERC20("Thin Token", "THIN", 18);
        fixedOracle = new MockPriceOracle();
        fixedOracle.setPrice(address(weth), 2_000e18);
        pool = new MockAMMOracle(address(usdc), address(thin), 6, 18);
        usdc.mint(me, 3_000_000e6);
        weth.mint(me, 1_000e18);
        thin.mint(me, 100_000e18);
        usdc.approve(address(pool), 10_000e6);
        thin.approve(address(pool), 10_000e18);
        pool.seed(10_000e6, 10_000e18);
    }

    function _core() internal {
        address[] memory one = new address[](1);
        one[0] = me;
        address[] memory guardians = new address[](1);
        guardians[0] = vm.envOr("GUARDIAN_ADDRESS", me);
        timelock = new GuardTimelock(one, one, guardians, one, 1);
        registry = new AttestationRegistry(address(timelock), vm.envOr("ATTESTOR_ADDRESS", me));
        KronosGuard.GuardParams memory p = _guardParams();
        lend = new GuardedMiniLend(
            address(usdc), 6, address(timelock), address(registry), guardians[0], vm.envOr("MONITOR_ADDRESS", me), p
        );
        plain = new MiniLend(address(usdc), 6, me);
    }

    /// Approved parameters: from the Kronos package's kronos.config.json when KRONOS_CONFIG is set,
    /// otherwise demo defaults. The deployed config hash must match the package for verification to pass.
    function _guardParams() internal view returns (KronosGuard.GuardParams memory p) {
        string memory path = vm.envOr("KRONOS_CONFIG", string(""));
        if (bytes(path).length == 0) {
            return KronosGuard.GuardParams({
                protocolMinHealthBps: 10_000,
                maxSharePriceDeltaBps: 100,
                maxOracleDeviationBps: 500,
                attestationMaxAgeBlocks: 600,
                probationSeconds: 7 days,
                adminMaxUnderwaterIncrease: 0
            });
        }
        string memory json = vm.readFile(path);
        p.protocolMinHealthBps = vm.parseUint(vm.parseJsonString(json, ".guardParams.protocolMinHealthBps"));
        p.maxSharePriceDeltaBps = vm.parseUint(vm.parseJsonString(json, ".guardParams.maxSharePriceDeltaBps"));
        p.maxOracleDeviationBps = vm.parseUint(vm.parseJsonString(json, ".guardParams.maxOracleDeviationBps"));
        p.attestationMaxAgeBlocks = vm.parseUint(vm.parseJsonString(json, ".guardParams.attestationMaxAgeBlocks"));
        p.probationSeconds = vm.parseUint(vm.parseJsonString(json, ".guardParams.probationSeconds"));
        p.adminMaxUnderwaterIncrease = vm.parseUint(vm.parseJsonString(json, ".guardParams.adminMaxUnderwaterIncrease"));
    }

    function _bootstrap() internal {
        _installTiers(timelock, address(lend));
        timelock.setupCall(
            address(lend),
            abi.encodeCall(MiniLendCore.listAsset, (address(weth), address(fixedOracle), 18, 8_000, 5_000_000e6))
        );
        timelock.setupCall(
            address(lend), abi.encodeCall(MiniLendCore.listAsset, (address(thin), address(pool), 18, 7_000, 50_000e6))
        );
        timelock.setupCall(
            address(lend), abi.encodeCall(KronosGuard.setOutflowThreshold, (address(usdc), 200_000e6, 100_000e6))
        );
        timelock.finalizeSetup(address(lend));
        plain.listAsset(address(weth), address(fixedOracle), 18, 8_000, type(uint256).max);
        plain.listAsset(address(thin), address(pool), 18, 7_000, type(uint256).max);
    }

    function _seed() internal {
        // Seed liquidity: the deployer signs a DepositIntent and submits it itself.
        usdc.approve(address(lend), 1_000_000e6);
        KronosGuard.Intent memory i = KronosGuard.Intent({
            asset: address(usdc),
            amount: 1_000_000e6,
            maxLtvBps: 0,
            minHealthBps: 0,
            account: me,
            recipient: address(0),
            deadline: block.timestamp + 1 hours,
            nonce: uint256(keccak256(abi.encode(block.timestamp, "seed")))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, lend.intentDigest(KronosGuard.Kind.Deposit, i));
        lend.deposit(i, abi.encodePacked(r, s, v));
        usdc.approve(address(plain), 1_000_000e6);
        plain.deposit(address(usdc), 1_000_000e6);
    }

    function _write(Out memory o) internal {
        string memory k = "deploy";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "usdc", o.usdc);
        vm.serializeAddress(k, "weth", o.weth);
        vm.serializeAddress(k, "thin", o.thin);
        vm.serializeAddress(k, "fixedOracle", o.fixedOracle);
        vm.serializeAddress(k, "thinPool", o.thinPool);
        vm.serializeAddress(k, "registry", o.registry);
        vm.serializeAddress(k, "timelock", o.timelock);
        vm.serializeAddress(k, "miniLend", o.miniLend);
        vm.serializeBytes32(k, "configHash", lend.kronosConfigHash());
        string memory json = vm.serializeAddress(k, "guardedMiniLend", o.guardedMiniLend);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("GuardedMiniLend", o.guardedMiniLend);
        console2.log("GuardTimelock  ", o.timelock);
        console2.log("Registry       ", o.registry);
    }

    function _installTiers(GuardTimelock t, address target) internal {
        bytes4[] memory sels = new bytes4[](17);
        uint8[] memory tiers = new uint8[](17);
        sels[0] = MiniLendCore.listAsset.selector; tiers[0] = 2;
        sels[1] = MiniLendCore.setOracle.selector; tiers[1] = 2;
        sels[2] = MiniLendCore.setCollateralFactor.selector; tiers[2] = 2;
        sels[3] = MiniLendCore.setCap.selector; tiers[3] = 2;
        sels[4] = MiniLendCore.lowerCap.selector; tiers[4] = 0;
        sels[5] = MiniLendCore.lowerCollateralFactor.selector; tiers[5] = 0;
        sels[6] = MiniLendCore.freezeAsset.selector; tiers[6] = 0;
        sels[7] = MiniLendCore.pause.selector; tiers[7] = 0;
        sels[8] = MiniLendCore.unfreezeAsset.selector; tiers[8] = 1;
        sels[9] = MiniLendCore.unpause.selector; tiers[9] = 1;
        sels[10] = MiniLendCore.setBorrowRate.selector; tiers[10] = 1;
        sels[11] = KronosGuard.setOutflowThreshold.selector; tiers[11] = 1;
        sels[12] = KronosGuard.setReleaseDelay.selector; tiers[12] = 1;
        sels[13] = KronosGuard.setGuardParams.selector; tiers[13] = 3;
        sels[14] = KronosGuard.setGuardian.selector; tiers[14] = 3;
        sels[15] = KronosGuard.setMonitor.selector; tiers[15] = 3;
        sels[16] = KronosGuard.setRegistry.selector; tiers[16] = 3;
        t.setupTiers(target, sels, tiers);
    }
}
