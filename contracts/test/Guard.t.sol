// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BaseTest} from "./Base.t.sol";
import {KronosGuard} from "../src/KronosGuard.sol";
import {GuardTimelock} from "../src/GuardTimelock.sol";
import {OutflowBreaker} from "../src/OutflowBreaker.sol";
import {LendingInvariants} from "../src/LendingInvariants.sol";
import {MiniLend} from "../src/samples/MiniLend.sol";
import {MiniLendCore} from "../src/samples/MiniLendCore.sol";
import {MockPriceOracle} from "../src/mocks/Mocks.sol";

contract GuardTest is BaseTest {
    // ================================================================ normal traffic must pass

    function test_NormalFlows_Pass() public {
        _fund(alice, weth, 10e18, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        _exec(lend, KronosGuard.Kind.Borrow, aliceKey, _intent(address(usdc), 5_000e6, 7_000, 12_000, alice, address(0)));
        assertEq(usdc.balanceOf(alice), 5_000e6);
        assertEq(lend.ltvBps(alice), 2_500);

        vm.warp(block.timestamp + 30 days);
        _attest(true, true, 1e18);
        _fund(alice, usdc, 0, address(lend));
        vm.prank(alice);
        usdc.approve(address(lend), 5_000e6);
        _exec(lend, KronosGuard.Kind.Repay, aliceKey, _intent(address(usdc), 5_000e6, 0, 0, alice, address(0)));
        assertEq(lend.debtOf(alice), 0);
        _exec(lend, KronosGuard.Kind.Withdraw, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        assertEq(weth.balanceOf(alice), 10e18);

        _fund(bob, usdc, 50_000e6, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, bobKey, _intent(address(usdc), 50_000e6, 0, 0, bob, address(0)));
        _exec(lend, KronosGuard.Kind.Withdraw, bobKey, _intent(address(usdc), 49_999e6, 0, 0, bob, address(0)));
        assertEq(usdc.balanceOf(bob), 49_999e6);
    }

    function test_InterestAccrual_DoesNotTripSharePrice() public {
        vm.prank(ADMIN);
        uint256 id = timelock.queue(address(lend), abi.encodeCall(MiniLendCore.setBorrowRate, (3e9))); // ~10% APR
        vm.warp(block.timestamp + 48 hours);
        vm.prank(ADMIN);
        timelock.execute(id);
        _attest(true, true, 1e18);
        _fund(alice, weth, 100e18, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 100e18, 0, 0, alice, address(0)));
        _exec(lend, KronosGuard.Kind.Borrow, aliceKey, _intent(address(usdc), 100_000e6, 6_000, 10_000, alice, address(0)));
        vm.warp(block.timestamp + 365 days);
        _attest(true, true, 1e18);
        _fund(bob, usdc, 1_000e6, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, bobKey, _intent(address(usdc), 1_000e6, 0, 0, bob, address(0)));
    }

    // ================================================================ intent pre-checks

    function test_NoValidIntent_Reverts() public {
        KronosGuard.Intent memory i = _intent(address(usdc), 1e6, 0, 0, alice, address(0));
        vm.expectRevert(KronosGuard.BadIntentSignature.selector);
        lend.borrow(i, hex"");
    }

    function test_ExpiredIntent_Reverts() public {
        KronosGuard.Intent memory i = _intent(address(weth), 1e18, 0, 0, alice, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Deposit, aliceKey, i);
        vm.warp(i.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(KronosGuard.IntentExpired.selector, i.deadline));
        lend.deposit(i, sig);
    }

    function test_ReplayedIntent_Reverts() public {
        _fund(alice, weth, 2e18, address(lend));
        KronosGuard.Intent memory i = _intent(address(weth), 1e18, 0, 0, alice, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Deposit, aliceKey, i);
        lend.deposit(i, sig);
        vm.expectRevert(abi.encodeWithSelector(KronosGuard.IntentReplayed.selector, alice, i.nonce));
        lend.deposit(i, sig);
    }

    function test_SignedForOneActionCantBeUsedForAnother() public {
        _fund(alice, weth, 10e18, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        // A RepayIntent signature replayed as a BorrowIntent recovers a different signer
        KronosGuard.Intent memory i = _intent(address(usdc), 1_000e6, 7_000, 10_000, alice, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Repay, aliceKey, i);
        vm.expectPartialRevert(KronosGuard.AccountNotSigner.selector);
        lend.borrow(i, sig);
    }

    function test_HackedFrontend_CantRedirectFunds() public {
        _fund(alice, weth, 10e18, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        KronosGuard.Intent memory i = _intent(address(usdc), 1_000e6, 7_000, 10_000, alice, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Borrow, aliceKey, i);
        i.recipient = ATTACKER; // tampered after signing
        vm.expectPartialRevert(KronosGuard.AccountNotSigner.selector);
        lend.borrow(i, sig);
        i.recipient = address(0);
        i.amount = 50_000e6; // pushing amount beyond the signed bound also breaks the signature
        vm.expectPartialRevert(KronosGuard.AccountNotSigner.selector);
        lend.borrow(i, sig);
    }

    function test_ExplicitRecipient_Allowed() public {
        _fund(alice, weth, 10e18, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        _exec(lend, KronosGuard.Kind.Borrow, aliceKey, _intent(address(usdc), 1_000e6, 7_000, 10_000, alice, bob));
        assertEq(usdc.balanceOf(bob), 1_000e6);
    }

    function test_MaxLtvBound_Enforced() public {
        _fund(alice, weth, 10e18, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        KronosGuard.Intent memory i = _intent(address(usdc), 12_000e6, 5_000, 10_000, alice, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Borrow, aliceKey, i);
        vm.expectRevert(abi.encodeWithSelector(LendingInvariants.CheckLtvFailed.selector, alice, 6_000, 5_000));
        lend.borrow(i, sig);
    }

    function test_MinHealthBound_Enforced() public {
        _fund(alice, weth, 10e18, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        KronosGuard.Intent memory i = _intent(address(usdc), 12_000e6, 7_000, 15_000, alice, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Borrow, aliceKey, i);
        vm.expectPartialRevert(LendingInvariants.CheckHealthFailed.selector);
        lend.borrow(i, sig);
    }

    function test_FrozenAsset_BlocksDeposit() public {
        vm.prank(GUARDIAN);
        timelock.tighten(address(lend), abi.encodeCall(MiniLendCore.freezeAsset, (address(thin))));
        _fund(alice, thin, 1e18, address(lend));
        KronosGuard.Intent memory i = _intent(address(thin), 1e18, 0, 0, alice, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Deposit, aliceKey, i);
        vm.expectRevert(abi.encodeWithSelector(KronosGuard.AssetFrozen.selector, address(thin)));
        lend.deposit(i, sig);
    }

    // ================================================================ circuit breaker

    function test_Breaker_SplitWithdrawalsCountTheSame() public {
        (address w, uint256 wk) = makeAddrAndKey("whale");
        _fund(w, usdc, 500_000e6, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, wk, _intent(address(usdc), 500_000e6, 0, 0, w, address(0)));
        vm.warp(block.timestamp + 25 hours); // inflows age out of the window
        _attest(true, true, 1e18);

        uint256 queued;
        for (uint256 k; k < 25; k++) {
            uint256 before = lend.claimsCount();
            _exec(lend, KronosGuard.Kind.Withdraw, wk, _intent(address(usdc), 10_000e6, 0, 0, w, address(0)));
            if (lend.claimsCount() > before) queued++;
        }
        assertEq(usdc.balanceOf(w), 200_000e6, "only the 24h threshold paid out");
        assertEq(queued, 5, "the rest is queued, not reverted");
        assertEq(lend.pendingOutflow(address(usdc)), 50_000e6);

        // release paths: fresh solvency attestation, guardian approval, delay
        vm.expectRevert(abi.encodeWithSelector(OutflowBreaker.ClaimNotReleasable.selector, 0));
        lend.releaseOutflow(0);
        vm.warp(block.timestamp + 1);
        _attest(true, true, 1e18);
        lend.releaseOutflow(0);
        vm.prank(GUARDIAN);
        lend.approveOutflow(1);
        lend.releaseOutflow(1);
        vm.warp(block.timestamp + 6 hours);
        lend.releaseOutflow(2);
        assertEq(usdc.balanceOf(w), 230_000e6);
    }

    function test_Breaker_StaleAttestationQueuesLargeOutflows() public {
        (address w, uint256 wk) = makeAddrAndKey("whale");
        _fund(w, usdc, 300_000e6, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, wk, _intent(address(usdc), 300_000e6, 0, 0, w, address(0)));
        vm.roll(block.number + _params().attestationMaxAgeBlocks + 1); // prover down: attestation is stale
        _exec(lend, KronosGuard.Kind.Withdraw, wk, _intent(address(usdc), 1_000e6, 0, 0, w, address(0)));
        assertEq(usdc.balanceOf(w), 1_000e6, "small actions continue");
        _exec(lend, KronosGuard.Kind.Withdraw, wk, _intent(address(usdc), 150_000e6, 0, 0, w, address(0)));
        assertEq(usdc.balanceOf(w), 1_000e6, "large outflow waits");
        assertEq(lend.claimsCount(), 1);
    }

    function test_Monitor_TightenOnly() public {
        vm.prank(MONITOR);
        lend.tightenOutflow(address(usdc), 50_000e6);
        assertEq(lend.outflowThreshold(address(usdc)), 50_000e6);
        vm.prank(MONITOR);
        vm.expectRevert(abi.encodeWithSelector(OutflowBreaker.NotTighter.selector, 50_000e6, 500_000e6));
        lend.tightenOutflow(address(usdc), 500_000e6);
        vm.prank(ATTACKER);
        vm.expectRevert(OutflowBreaker.NotMonitorOrGuardian.selector);
        lend.tightenOutflow(address(usdc), 1);
    }

    // ================================================================ admin strategy

    function test_Tier0_PauseIsInstant_UnpauseTakes48h() public {
        vm.prank(GUARDIAN);
        timelock.tighten(address(lend), abi.encodeCall(MiniLendCore.pause, ()));
        assertTrue(lend.paused());
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(GuardTimelock.WrongTier.selector, uint8(1)));
        timelock.tighten(address(lend), abi.encodeCall(MiniLendCore.unpause, ()));
        vm.prank(ADMIN);
        uint256 id = timelock.queue(address(lend), abi.encodeCall(MiniLendCore.unpause, ()));
        assertEq(timelock.getAction(id).eta, block.timestamp + 48 hours);
    }

    function test_Tier3_NeedsIndependentCosign() public {
        vm.prank(GOV);
        uint256 id = timelock.queue(address(lend), abi.encodeCall(KronosGuard.setGuardian, (ATTACKER)));
        vm.warp(block.timestamp + 14 days);
        vm.prank(GOV);
        vm.expectRevert(abi.encodeWithSelector(GuardTimelock.NeedCosigns.selector, uint16(0), uint16(2)));
        timelock.execute(id);
        vm.prank(C1);
        timelock.cosign(id);
        vm.prank(C2);
        timelock.cosign(id);
        vm.prank(GOV);
        timelock.execute(id);
        assertEq(lend.guardian(), ATTACKER);
    }

    function test_UnknownSelector_Rejected() public {
        vm.prank(ADMIN);
        vm.expectPartialRevert(GuardTimelock.UnknownSelector.selector);
        timelock.queue(address(lend), abi.encodeWithSignature("drain(address)", ATTACKER));
    }

    function test_AdminChangeThatPutsAccountsUnderwater_Reverts() public {
        _fund(alice, weth, 10e18, address(lend));
        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        _exec(lend, KronosGuard.Kind.Borrow, aliceKey, _intent(address(usdc), 14_000e6, 8_000, 10_000, alice, address(0)));
        MockPriceOracle bad = new MockPriceOracle();
        bad.setPrice(address(weth), 500e18);
        vm.prank(GOV); // hijacked vote
        uint256 id = timelock.queue(address(lend), abi.encodeCall(MiniLendCore.setOracle, (address(weth), address(bad))));
        vm.warp(block.timestamp + 7 days);
        vm.prank(GOV);
        vm.expectPartialRevert(LendingInvariants.CheckAdminUnderwaterFailed.selector);
        timelock.execute(id);
    }

    function test_SetupClosedAfterFinalize() public {
        vm.prank(ADMIN);
        vm.expectRevert(GuardTimelock.Unauthorized.selector);
        timelock.setupCall(address(lend), abi.encodeCall(MiniLendCore.setCap, (address(thin), type(uint256).max)));
        assertTrue(timelock.finalized(address(lend)));
    }

    function test_ConfigHash() public view {
        assertEq(lend.kronosConfigHash(), keccak256(abi.encode(_params())));
        assertEq(lend.kronosTimelock(), address(timelock));
    }

    // ================================================================ gas overhead report

    function test_GasOverhead() public {
        MiniLend plain = new MiniLend(address(usdc), 6, ADMIN);
        vm.prank(ADMIN);
        plain.listAsset(address(weth), address(fixedOracle), 18, 8_000, type(uint256).max);
        usdc.mint(LP, 100_000e6);
        vm.startPrank(LP);
        usdc.approve(address(plain), 100_000e6);
        plain.deposit(address(usdc), 100_000e6);
        vm.stopPrank();
        weth.mint(alice, 20e18);
        vm.startPrank(alice);
        weth.approve(address(plain), 10e18);
        weth.approve(address(lend), 10e18);
        plain.deposit(address(weth), 10e18);
        uint256 g0 = gasleft();
        plain.borrow(1_000e6);
        uint256 plainGas = g0 - gasleft();
        vm.stopPrank();

        _exec(lend, KronosGuard.Kind.Deposit, aliceKey, _intent(address(weth), 10e18, 0, 0, alice, address(0)));
        KronosGuard.Intent memory i = _intent(address(usdc), 1_000e6, 7_000, 10_000, alice, address(0));
        bytes memory sig = _sign(lend, KronosGuard.Kind.Borrow, aliceKey, i);
        g0 = gasleft();
        lend.borrow(i, sig);
        uint256 guardedGas = g0 - gasleft();
        console2.log("borrow gas plain   ", plainGas);
        console2.log("borrow gas guarded ", guardedGas);
        console2.log("overhead           ", guardedGas - plainGas);
        assertLt(guardedGas - plainGas, 150_000);
    }
}
