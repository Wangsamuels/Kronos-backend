// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KronosGuard} from "../src/KronosGuard.sol";
import {GuardTimelock} from "../src/GuardTimelock.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {GuardedMiniLend} from "../src/samples/GuardedMiniLend.sol";
import {MiniLendCore} from "../src/samples/MiniLendCore.sol";
import {MockERC20, MockPriceOracle, MockAMMOracle} from "../src/mocks/Mocks.sol";

/// Shared fixture: a GuardedMiniLend wired to a GuardTimelock and an AttestationRegistry, with WETH
/// (fixed oracle) and THIN (thin AMM oracle) listed through the timelock, probation elapsed, and a fresh
/// attestation posted.
abstract contract BaseTest is Test {
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 thin;
    MockPriceOracle fixedOracle;
    MockAMMOracle thinPool;

    GuardTimelock timelock;
    AttestationRegistry registry;
    GuardedMiniLend lend;

    address ADMIN = makeAddr("admin");
    address GOV = makeAddr("governance");
    address GUARDIAN = makeAddr("guardian");
    address MONITOR = makeAddr("monitor");
    address C1 = makeAddr("cosigner1");
    address C2 = makeAddr("cosigner2");
    address LP = makeAddr("lp");
    address RELAYER = makeAddr("relayer");
    address ATTACKER;
    uint256 attackerKey;
    address alice;
    uint256 aliceKey;
    address bob;
    uint256 bobKey;
    uint256 attestorKey = 0xA77E57;

    uint256 nonceCounter = 1;

    function _params() internal pure returns (KronosGuard.GuardParams memory) {
        return KronosGuard.GuardParams({
            protocolMinHealthBps: 10_000,
            maxSharePriceDeltaBps: 100, // 1%
            maxOracleDeviationBps: 500, // 5% from attested TWAP
            attestationMaxAgeBlocks: 50,
            probationSeconds: 7 days,
            adminMaxUnderwaterIncrease: 0
        });
    }

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        vm.roll(1_000);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        (ATTACKER, attackerKey) = makeAddrAndKey("attacker");

        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        thin = new MockERC20("Thin Token", "THIN", 18);
        fixedOracle = new MockPriceOracle();
        fixedOracle.setPrice(address(weth), 2_000e18);
        thinPool = new MockAMMOracle(address(usdc), address(thin), 6, 18);
        usdc.mint(address(this), 10_000e6);
        thin.mint(address(this), 10_000e18);
        usdc.approve(address(thinPool), type(uint256).max);
        thin.approve(address(thinPool), type(uint256).max);
        thinPool.seed(10_000e6, 10_000e18); // $1, only $20k of liquidity

        address[] memory admins = new address[](1);
        admins[0] = ADMIN;
        address[] memory gov = new address[](1);
        gov[0] = GOV;
        address[] memory guardians = new address[](1);
        guardians[0] = GUARDIAN;
        address[] memory cosigners = new address[](2);
        cosigners[0] = C1;
        cosigners[1] = C2;
        timelock = new GuardTimelock(admins, gov, guardians, cosigners, 2);
        registry = new AttestationRegistry(address(timelock), vm.addr(attestorKey));

        lend = _deployGuarded();

        // List markets + configure the breaker — all through the timelock.
        vm.startPrank(ADMIN);
        uint256 a = timelock.queue(
            address(lend), abi.encodeCall(MiniLendCore.listAsset, (address(weth), address(fixedOracle), 18, 8_000, 5_000_000e6))
        );
        uint256 b = timelock.queue(
            address(lend), abi.encodeCall(MiniLendCore.listAsset, (address(thin), address(thinPool), 18, 7_000, 50_000e6))
        );
        uint256 c = timelock.queue(
            address(lend), abi.encodeCall(KronosGuard.setOutflowThreshold, (address(usdc), 200_000e6, 100_000e6))
        );
        vm.warp(block.timestamp + 7 days);
        timelock.execute(a);
        timelock.execute(b);
        timelock.execute(c);
        vm.stopPrank();
        vm.warp(block.timestamp + _params().probationSeconds); // probation elapsed

        _attest(true, true, 1e18);

        // Liquidity from an LP.
        (address lpAddr, uint256 lpKey) = makeAddrAndKey("lp");
        LP = lpAddr;
        _fund(LP, usdc, 1_000_000e6, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, lpKey, _intent(address(usdc), 1_000_000e6, 0, 0, LP, address(0)));
    }

    function _deployGuarded() internal returns (GuardedMiniLend g) {
        g = new GuardedMiniLend(address(usdc), 6, address(timelock), address(registry), GUARDIAN, MONITOR, _params());
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
        vm.startPrank(ADMIN);
        timelock.setupTiers(address(g), sels, tiers);
        timelock.finalizeSetup(address(g));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _intent(address asset, uint256 amount, uint256 maxLtv, uint256 minHealth, address account, address recipient)
        internal
        returns (KronosGuard.Intent memory)
    {
        return KronosGuard.Intent({
            asset: asset,
            amount: amount,
            maxLtvBps: maxLtv,
            minHealthBps: minHealth,
            account: account,
            recipient: recipient,
            deadline: block.timestamp + 1 hours,
            nonce: nonceCounter++
        });
    }

    function _sign(GuardedMiniLend g, KronosGuard.Kind kind, uint256 key, KronosGuard.Intent memory i)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = g.intentDigest(kind, i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Signs with `key` and submits from RELAYER (users never need to pay gas themselves).
    function _exec(GuardedMiniLend g, KronosGuard.Kind kind, uint256 key, KronosGuard.Intent memory i) internal {
        bytes memory sig = _sign(g, kind, key, i);
        vm.prank(RELAYER);
        _call(g, kind, i, sig);
    }

    function _call(GuardedMiniLend g, KronosGuard.Kind kind, KronosGuard.Intent memory i, bytes memory sig) internal {
        if (kind == KronosGuard.Kind.Deposit) g.deposit(i, sig);
        else if (kind == KronosGuard.Kind.Withdraw) g.withdraw(i, sig);
        else if (kind == KronosGuard.Kind.Borrow) g.borrow(i, sig);
        else if (kind == KronosGuard.Kind.Repay) g.repay(i, sig);
        else g.liquidate(i, sig);
    }

    function _attest(bool oracleOk, bool solvencyOk, uint256 thinTwap) internal {
        _attestFor(address(lend), oracleOk, solvencyOk, thinTwap);
    }

    function _attestFor(address protocol, bool oracleOk, bool solvencyOk, uint256 thinTwap) internal {
        vm.roll(block.number + 1);
        address[] memory assets = new address[](2);
        assets[0] = address(weth);
        assets[1] = address(thin);
        uint256[] memory twaps = new uint256[](2);
        twaps[0] = 2_000e18;
        twaps[1] = thinTwap;
        _postAttestation(protocol, oracleOk, solvencyOk, assets, twaps);
    }

    function _postAttestation(
        address protocol,
        bool oracleOk,
        bool solvencyOk,
        address[] memory assets,
        uint256[] memory twaps
    ) internal {
        uint64 bn = uint64(block.number);
        bytes32 h = registry.payloadHash(protocol, bn, oracleOk, solvencyOk, assets, twaps);
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, eth);
        registry.post(protocol, bn, oracleOk, solvencyOk, assets, twaps, abi.encodePacked(r, s, v));
    }

    function _fund(address who, MockERC20 token, uint256 amount, address spender) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(spender, amount); // exact-amount approvals only
    }
}
