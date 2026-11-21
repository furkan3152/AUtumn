// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GoldBuyer, ISwapRouter02} from "../src/GoldBuyer.sol";

interface IToken {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IPoolAdmin {
    function increaseObservationCardinalityNext(uint16) external;
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

/// Fork tests against Celo mainnet state. Nothing here is broadcast.
contract GoldBuyerTest is Test {
    uint256 constant FORK_BLOCK = 83_384_000; // 2026-11-21, 1-second blocks
    IToken constant USDT = IToken(0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e);
    IToken constant XAUT0 = IToken(0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff);
    IPoolAdmin constant POOL = IPoolAdmin(0xbb469A28f64C72aECC7d05Ca6e45B2FB1a63B4F9);
    address constant ROUTER = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    IQuoterV2 constant QUOTER = IQuoterV2(0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8);
    // toDataSuffix("celo_c24c5a65e5a3"), the ERC-8021 tag from derisk/RESULTS.md section 7
    bytes constant TAG = hex"63656c6f5f633234633561363565356133110080218021802180218021802180218021";

    GoldBuyer buyer;
    address wallet = makeAddr("wallet");
    address trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork("celo", FORK_BLOCK);
        buyer = new GoldBuyer();
        deal(address(USDT), wallet, 1_000e6);
        deal(address(USDT), trader, 1_000_000e6);
        vm.prank(trader);
        USDT.approve(ROUTER, type(uint256).max);
        vm.prank(trader);
        XAUT0.approve(ROUTER, type(uint256).max);
    }

    // ---- helpers ----

    function _routerSwap(address from, uint256 amountIn) internal returns (uint256) {
        return _routerSwap(from, USDT, XAUT0, amountIn);
    }

    function _routerSwap(address from, IToken tokenIn, IToken tokenOut, uint256 amountIn) internal returns (uint256) {
        vm.prank(from);
        return ISwapRouter02(ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(address(tokenIn), address(tokenOut), 3000, from, amountIn, 0, 0)
        );
    }

    function _next(uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs);
    }

    /// The live pool keeps only 1 observation. Do the one-time public cardinality increase
    /// and let 40 minutes of round-trip trades (each one moves the tick, so each writes an observation)
    /// fill the history.
    function _seedHistory() internal {
        POOL.increaseObservationCardinalityNext(100);
        for (uint256 i; i < 10; i++) {
            _next(120);
            uint256 gold = _routerSwap(trader, 1_000e6);
            _next(120);
            _routerSwap(trader, XAUT0, USDT, gold);
        }
        _next(30);
    }

    function _quote(uint256 amountIn) internal returns (uint256 out) {
        (out,,,) = QUOTER.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams(address(USDT), address(XAUT0), amountIn, 3000, 0)
        );
    }

    function _buy(address from, uint256 amountIn, uint256 minOut) internal returns (uint256) {
        vm.startPrank(from);
        USDT.approve(address(buyer), amountIn);
        uint256 out = buyer.buy(amountIn, minOut);
        vm.stopPrank();
        return out;
    }

    function _checkBuy(uint256 amountIn) internal {
        _seedHistory();
        uint256 quoted = _quote(amountIn);
        uint256 usdtBefore = USDT.balanceOf(wallet);
        uint256 goldBefore = XAUT0.balanceOf(wallet);

        vm.startPrank(wallet);
        USDT.approve(address(buyer), amountIn);
        vm.expectEmit(true, false, false, true, address(buyer));
        emit GoldBuyer.Bought(wallet, amountIn, quoted);
        uint256 gasBefore = gasleft();
        uint256 out = buyer.buy(amountIn, quoted * 99 / 100);
        emit log_named_uint("gas used by buy()", gasBefore - gasleft());
        vm.stopPrank();

        assertEq(out, quoted, "matches QuoterV2");
        assertGt(out, 0);
        assertEq(XAUT0.balanceOf(wallet) - goldBefore, out, "gold landed on caller");
        assertEq(usdtBefore - USDT.balanceOf(wallet), amountIn, "spent exactly amountIn");
        assertEq(USDT.balanceOf(address(buyer)), 0, "no USDT left in contract");
        assertEq(XAUT0.balanceOf(address(buyer)), 0, "no XAUt0 left in contract");
        assertEq(USDT.allowance(address(buyer), ROUTER), 0, "no router allowance left");
        assertEq(USDT.allowance(wallet, address(buyer)), 0, "caller's allowance used up");
    }

    // ---- tests ----

    function test_buy5Dollars() public {
        _checkBuy(5e6);
    }

    function test_buy50Dollars() public {
        _checkBuy(50e6);
    }

    /// There is no recipient parameter: output goes to whoever calls, and nobody else gains.
    function test_outputOnlyReachesMsgSender() public {
        _seedHistory();
        address other = makeAddr("other");
        deal(address(USDT), other, 10e6);
        uint256 walletGold = XAUT0.balanceOf(wallet);
        uint256 out = _buy(other, 10e6, 0);
        assertEq(XAUT0.balanceOf(other), out);
        assertEq(XAUT0.balanceOf(wallet), walletGold);
        assertEq(XAUT0.balanceOf(address(buyer)), 0);
    }

    /// A large swap in the same block pushes the price far below the TWAP; the buy must revert
    /// even when the caller asks for no minimum.
    function test_revertsWhenPriceManipulatedSameBlock() public {
        _seedHistory();
        (, int24 tickBefore,,,,,) = POOL.slot0();
        _routerSwap(trader, 20_000e6);
        (, int24 tickAfter,,,,,) = POOL.slot0();
        assertLt(tickAfter, tickBefore - 100, "manipulation moved price more than 1%");

        vm.startPrank(wallet);
        USDT.approve(address(buyer), 5e6);
        vm.expectRevert(bytes("price below TWAP floor"));
        buyer.buy(5e6, 0);
        vm.stopPrank();
    }

    /// Waiting a minute after the manipulation does not help: the 30-minute average barely moves.
    function test_revertsWhenPriceManipulatedOneMinuteEarlier() public {
        _seedHistory();
        _routerSwap(trader, 20_000e6);
        _next(60);
        vm.startPrank(wallet);
        USDT.approve(address(buyer), 5e6);
        vm.expectRevert(bytes("price below TWAP floor"));
        buyer.buy(5e6, 0);
        vm.stopPrank();
    }

    /// A small, ordinary price move inside the bound still lets the buy through.
    function test_smallMoveWithinBoundSucceeds() public {
        _seedHistory();
        _routerSwap(trader, 500e6);
        assertGt(_buy(wallet, 5e6, 0), 0);
    }

    function test_revertsWhenMinOutTooHigh() public {
        _seedHistory();
        uint256 quoted = _quote(5e6);
        vm.startPrank(wallet);
        USDT.approve(address(buyer), 5e6);
        vm.expectRevert(bytes("Too little received"));
        buyer.buy(5e6, quoted + 1);
        vm.stopPrank();
    }

    function test_revertsWithoutApproval() public {
        _seedHistory();
        vm.prank(wallet);
        vm.expectRevert();
        buyer.buy(5e6, 0);
    }

    /// ERC-8021 attribution suffix appended after the ABI-encoded arguments is ignored.
    function test_toleratesTrailingAttributionSuffix() public {
        _seedHistory();
        uint256 quoted = _quote(5e6);
        vm.startPrank(wallet);
        USDT.approve(address(buyer), 5e6);
        bytes memory data = bytes.concat(abi.encodeCall(GoldBuyer.buy, (5e6, quoted)), TAG);
        assertEq(data.length, 4 + 64 + 35);
        (bool ok, bytes memory ret) = address(buyer).call(data);
        vm.stopPrank();
        assertTrue(ok, "call with suffix succeeded");
        assertEq(abi.decode(ret, (uint256)), quoted);
        assertEq(USDT.balanceOf(address(buyer)), 0);
    }

    /// With the pool as it is on mainnet today (observation cardinality 1), a trade that moved the
    /// tick in the last 30 minutes means no 30-minute average exists, so buy fails closed ("OLD").
    function test_failsClosedWithLiveCardinalityOfOne() public {
        (,,, uint16 cardinality,,,) = POOL.slot0();
        assertEq(cardinality, 1);
        (, int24 tickBefore,,,,,) = POOL.slot0();
        _routerSwap(trader, 1_000e6);
        (, int24 tickAfter,,,,,) = POOL.slot0();
        assertTrue(tickAfter != tickBefore, "trade moved the tick, so an observation was written");
        _next(60);
        vm.startPrank(wallet);
        USDT.approve(address(buyer), 5e6);
        vm.expectRevert(bytes("OLD"));
        buyer.buy(5e6, 0);
        vm.stopPrank();
    }

    /// At cardinality 1, if no trade has moved the tick for 30 minutes (true at the pinned block, whose
    /// last observation is about 4.7 hours old), the average is that unchanged tick and buy works.
    function test_worksAtCardinalityOneWhenPriceUnchangedFor30Minutes() public {
        (,,, uint16 cardinality,,,) = POOL.slot0();
        assertEq(cardinality, 1);
        uint256 quoted = _quote(5e6);
        assertEq(_buy(wallet, 5e6, quoted), quoted);
    }
}
