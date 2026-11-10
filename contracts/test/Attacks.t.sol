// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {KronosGuard} from "../src/KronosGuard.sol";
import {GuardTimelock} from "../src/GuardTimelock.sol";
import {LendingInvariants} from "../src/LendingInvariants.sol";
import {MiniLend} from "../src/samples/MiniLend.sol";
import {MiniLendCore} from "../src/samples/MiniLendCore.sol";
import {GuardedMiniLend} from "../src/samples/GuardedMiniLend.sol";
import {MockERC20, MockPriceOracle} from "../src/mocks/Mocks.sol";

/// The three demo attacks. Each runs twice: against plain MiniLend (the attack works) and against
/// GuardedMiniLend (the attack reverts or is queued).
contract AttacksTest is BaseTest {
    // ================================================================ 1. Oracle pump on thin collateral

    function test_OraclePump_DrainsUnguarded() public {
        MiniLend plain = new MiniLend(address(usdc), 6, ADMIN);
        vm.prank(ADMIN);
        plain.listAsset(address(thin), address(thinPool), 18, 7_000, type(uint256).max);
        usdc.mint(LP, 1_000_000e6);
        vm.startPrank(LP);
        usdc.approve(address(plain), 1_000_000e6);
        plain.deposit(address(usdc), 1_000_000e6);
        vm.stopPrank();

        uint256 stolen = _runPump(address(plain), false);
        assertGt(stolen, 500_000e6, "attacker profits > $500k");
    }

    function test_OraclePump_RevertsAtCheckOracle() public {
        thin.mint(ATTACKER, 10_000e18);
        usdc.mint(ATTACKER, 100_000e6);
        vm.startPrank(ATTACKER);
        thin.approve(address(lend), 10_000e18);
        usdc.approve(address(thinPool), 100_000e6);
        vm.stopPrank();
        _exec(lend, KronosGuard.Kind.Deposit, attackerKey, _intent(address(thin), 10_000e18, 0, 0, ATTACKER, address(0)));

        vm.prank(ATTACKER);
        thinPool.swapBaseForToken(100_000e6); // pump THIN from $1 to ~$121
        assertGt(lend.priceOf(address(thin)), 100e18);

        KronosGuard.Intent memory i = _intent(address(usdc), 800_000e6, 7_000, 10_000, ATTACKER, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Borrow, attackerKey, i);
        uint256 spot = lend.priceOf(address(thin));
        vm.expectRevert(
            abi.encodeWithSelector(
                LendingInvariants.CheckOracleFailed.selector, address(thin), spot, 1e18, _params().maxOracleDeviationBps
            )
        );
        vm.prank(RELAYER);
        lend.borrow(i, sig);
    }

    function _runPump(address target, bool) internal returns (uint256 profit) {
        MiniLend plain = MiniLend(target);
        thin.mint(ATTACKER, 10_000e18);
        usdc.mint(ATTACKER, 100_000e6);
        uint256 startUsdc = usdc.balanceOf(ATTACKER);
        vm.startPrank(ATTACKER);
        thin.approve(target, type(uint256).max);
        usdc.approve(address(thinPool), type(uint256).max);
        thin.approve(address(thinPool), type(uint256).max);
        plain.deposit(address(thin), 10_000e18);
        uint256 got = thinPool.swapBaseForToken(100_000e6);
        plain.borrow(800_000e6);
        thinPool.swapTokenForBase(got); // dump back
        vm.stopPrank();
        profit = usdc.balanceOf(ATTACKER) - startUsdc;
    }

    // ================================================================ 2. Share inflation / donation

    function test_ShareInflation_StealsFromVictimUnguarded() public {
        MiniLend plain = new MiniLend(address(usdc), 6, ADMIN);
        usdc.mint(ATTACKER, 10_000e6 + 1);
        usdc.mint(bob, 19_999e6);
        vm.startPrank(ATTACKER);
        usdc.approve(address(plain), 1);
        plain.deposit(address(usdc), 1); // 1 share
        usdc.transfer(address(plain), 10_000e6); // donate
        vm.stopPrank();
        vm.startPrank(bob);
        usdc.approve(address(plain), 19_999e6);
        plain.deposit(address(usdc), 19_999e6); // rounds down to 1 share
        vm.stopPrank();
        assertEq(plain.sharesOf(bob), 1);
        // attacker redeems his single share for half the pool
        uint256 redeemable = (plain.exchangeRate() * plain.sharesOf(ATTACKER)) / 1e18;
        vm.prank(ATTACKER);
        plain.withdraw(address(usdc), redeemable);
        assertGt(usdc.balanceOf(ATTACKER), 14_999e6, "attacker took ~5k of the victim's funds");
    }

    function test_ShareInflation_VictimDepositReverts() public {
        GuardedMiniLend fresh = _deployGuarded();
        _fund(ATTACKER, usdc, 1, address(fresh));
        _exec(fresh, KronosGuard.Kind.Deposit, attackerKey, _intent(address(usdc), 1, 0, 0, ATTACKER, address(0)));
        usdc.mint(ATTACKER, 10_000e6);
        vm.prank(ATTACKER);
        usdc.transfer(address(fresh), 10_000e6); // donation bypasses the guard...

        _fund(bob, usdc, 19_999e6, address(fresh));
        KronosGuard.Intent memory i = _intent(address(usdc), 19_999e6, 0, 0, bob, address(0));
        bytes memory sig = _sign(fresh, KronosGuard.Kind.Deposit, bobKey, i);
        vm.expectPartialRevert(LendingInvariants.CheckSharePriceFailed.selector); // ...but the next guarded call sees the jump
        vm.prank(RELAYER);
        fresh.deposit(i, sig);
        assertEq(usdc.balanceOf(bob), 19_999e6, "victim keeps funds");
    }

    // ================================================================ 3. Fake collateral listing (Drift pattern)

    function test_FakeCollateral_DrainsUnguarded() public {
        MiniLend plain = new MiniLend(address(usdc), 6, ADMIN);
        usdc.mint(LP, 1_000_000e6);
        vm.startPrank(LP);
        usdc.approve(address(plain), 1_000_000e6);
        plain.deposit(address(usdc), 1_000_000e6);
        vm.stopPrank();

        (MockERC20 fake, MockPriceOracle evil) = _fake();
        vm.prank(ADMIN); // stolen admin key
        plain.listAsset(address(fake), address(evil), 18, 9_000, type(uint256).max);
        vm.startPrank(ATTACKER);
        fake.approve(address(plain), 1e18);
        plain.deposit(address(fake), 1e18);
        plain.borrow(1_000_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(ATTACKER), 1_000_000e6, "pool drained instantly");
    }

    function test_FakeCollateral_QueuedSevenDaysAndGuardianCancels() public {
        (MockERC20 fake, MockPriceOracle evil) = _fake();
        bytes memory call = abi.encodeCall(MiniLendCore.listAsset, (address(fake), address(evil), 18, 9_000, type(uint256).max));

        // direct call with the stolen admin key: not the timelock
        vm.prank(ADMIN);
        vm.expectRevert(KronosGuard.NotTimelock.selector);
        lend.listAsset(address(fake), address(evil), 18, 9_000, type(uint256).max);

        // guardian can't fast-path a risk-adding change
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(GuardTimelock.WrongTier.selector, uint8(2)));
        timelock.tighten(address(lend), call);

        vm.prank(ADMIN);
        uint256 id = timelock.queue(address(lend), call);
        GuardTimelock.Action memory a = timelock.getAction(id);
        assertEq(a.tier, 2);
        assertEq(a.eta, block.timestamp + 7 days);

        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(GuardTimelock.NotReady.selector, a.eta));
        timelock.execute(id);

        vm.prank(GUARDIAN);
        vm.expectRevert(GuardTimelock.Unauthorized.selector); // cancel-only guardians
        timelock.execute(id);

        vm.prank(GUARDIAN);
        timelock.cancel(id);

        vm.warp(block.timestamp + 7 days);
        vm.prank(ADMIN);
        vm.expectRevert(GuardTimelock.AlreadyFinal.selector);
        timelock.execute(id);
    }

    function test_FakeCollateral_EvenIfListed_ProbationBlocksBorrow() public {
        (MockERC20 fake, MockPriceOracle evil) = _fake();
        vm.prank(ADMIN);
        uint256 id = timelock.queue(
            address(lend), abi.encodeCall(MiniLendCore.listAsset, (address(fake), address(evil), 18, 9_000, 1_000_000e6))
        );
        vm.warp(block.timestamp + 7 days);
        vm.prank(ADMIN);
        timelock.execute(id); // nobody cancelled

        vm.startPrank(ATTACKER);
        fake.approve(address(lend), 1e18);
        vm.stopPrank();
        _exec(lend, KronosGuard.Kind.Deposit, attackerKey, _intent(address(fake), 1e18, 0, 0, ATTACKER, address(0)));

        // (a) no clean attested price history yet
        KronosGuard.Intent memory i = _intent(address(usdc), 900_000e6, 9_000, 10_000, ATTACKER, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Borrow, attackerKey, i);
        vm.expectRevert(abi.encodeWithSelector(LendingInvariants.CheckOracleNoTwap.selector, address(fake)));
        vm.prank(RELAYER);
        lend.borrow(i, sig);

        // (b) even with an attested price matching the evil oracle, the cap is still ramping from 0
        vm.roll(block.number + 1);
        address[] memory assets = new address[](1);
        assets[0] = address(fake);
        uint256[] memory twaps = new uint256[](1);
        twaps[0] = 10_000_000e18;
        _postAttestation(address(lend), true, true, assets, twaps);
        vm.warp(block.timestamp + 1 days);
        i = _intent(address(usdc), 900_000e6, 9_000, 10_000, ATTACKER, address(0));
        sig = _sign(lend, KronosGuard.Kind.Borrow, attackerKey, i);
        vm.expectPartialRevert(LendingInvariants.CheckCapFailed.selector);
        vm.prank(RELAYER);
        lend.borrow(i, sig);
    }

    function _fake() internal returns (MockERC20 fake, MockPriceOracle evil) {
        fake = new MockERC20("Totally Real", "FAKE", 18);
        evil = new MockPriceOracle();
        evil.setPrice(address(fake), 10_000_000e18);
        fake.mint(ATTACKER, 1e18);
    }
}
