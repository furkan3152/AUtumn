// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GoldBuyer, ISwapRouter02} from "../src/GoldBuyer.sol";

/// Minimal USD₮ stand-in: balances, allowances, transferFrom.
contract MockUSDT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Pool stand-in: a fixed 30-minute average tick from `observe`, and the tick after the swap from `slot0`.
contract MockPool {
    int24 public averageTick;
    int24 public tickAfter;

    function set(int24 average, int24 afterSwap) external {
        averageTick = average;
        tickAfter = afterSwap;
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory c, uint160[] memory l) {
        c = new int56[](2);
        l = new uint160[](2);
        // cumulative grows by averageTick per second between secondsAgos[0] and now
        c[0] = 1_000_000;
        c[1] = 1_000_000 + int56(averageTick) * int56(uint56(secondsAgos[0]));
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, tickAfter, 0, 1, 1, 0, true);
    }
}

/// Router stand-in: pulls tokenIn from the caller, records the call, returns a fixed amount out.
contract MockRouter {
    uint256 public amountOut;
    ISwapRouter02.ExactInputSingleParams public last;

    function setAmountOut(uint256 out) external {
        amountOut = out;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external payable returns (uint256) {
        require(amountOut >= p.amountOutMinimum, "Too little received");
        MockUSDT(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        last = p;
        return amountOut;
    }
}

/// Offline tests: GoldBuyer's own logic against stand-ins placed at its constant addresses.
/// No RPC or secrets needed. The mainnet behaviour is covered by the fork tests in GoldBuyer.t.sol.
contract GoldBuyerUnitTest is Test {
    GoldBuyer buyer;
    MockUSDT usdt;
    MockPool pool;
    MockRouter router;
    address wallet = makeAddr("wallet");
    bytes constant TAG = hex"63656c6f5f633234633561363565356133110080218021802180218021802180218021";

    function setUp() public {
        buyer = new GoldBuyer();
        deployCodeTo("GoldBuyerUnit.t.sol:MockUSDT", address(buyer.USDT()));
        deployCodeTo("GoldBuyerUnit.t.sol:MockPool", address(buyer.POOL()));
        deployCodeTo("GoldBuyerUnit.t.sol:MockRouter", address(buyer.ROUTER()));
        usdt = MockUSDT(address(buyer.USDT()));
        pool = MockPool(address(buyer.POOL()));
        router = MockRouter(address(buyer.ROUTER()));
        usdt.mint(wallet, 100e6);
        pool.set(-50_000, -50_000);
        router.setAmountOut(1_234);
    }

    function _buy(uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        vm.startPrank(wallet);
        usdt.approve(address(buyer), amountIn);
        out = buyer.buy(amountIn, minOut);
        vm.stopPrank();
    }

    function test_buySwapsForTheCallerWithFixedPoolAndToken() public {
        vm.startPrank(wallet);
        usdt.approve(address(buyer), 5e6);
        vm.expectEmit(true, false, false, true, address(buyer));
        emit GoldBuyer.Bought(wallet, 5e6, 1_234);
        assertEq(buyer.buy(5e6, 1_000), 1_234);
        vm.stopPrank();

        (
            address tokenIn,
            address tokenOut,
            uint24 fee,
            address recipient,
            uint256 amountIn,
            uint256 minOut,
            uint160 limit
        ) = router.last();
        assertEq(tokenIn, address(usdt));
        assertEq(tokenOut, buyer.XAUT0());
        assertEq(fee, 3000);
        assertEq(recipient, wallet, "gold goes to the caller");
        assertEq(amountIn, 5e6);
        assertEq(minOut, 1_000, "caller's minimum passed through");
        assertEq(limit, 0);

        assertEq(usdt.balanceOf(wallet), 95e6, "spent exactly amountIn");
        assertEq(usdt.balanceOf(address(buyer)), 0, "nothing left in the contract");
        assertEq(usdt.allowance(address(buyer), address(router)), 0, "router allowance reset");
    }

    function test_outputAlwaysGoesToMsgSender() public {
        address other = makeAddr("other");
        usdt.mint(other, 10e6);
        vm.startPrank(other);
        usdt.approve(address(buyer), 10e6);
        buyer.buy(10e6, 0);
        vm.stopPrank();
        (,,, address recipient,,,) = router.last();
        assertEq(recipient, other);
    }

    function test_succeedsExactlyAtTheTwapFloor() public {
        pool.set(-50_000, -50_100); // 100 ticks below the average: allowed
        assertEq(_buy(5e6, 0), 1_234);
    }

    function test_revertsOneTickBelowTheTwapFloor() public {
        pool.set(-50_000, -50_101);
        vm.startPrank(wallet);
        usdt.approve(address(buyer), 5e6);
        vm.expectRevert(bytes("price below TWAP floor"));
        buyer.buy(5e6, 0);
        vm.stopPrank();
    }

    function test_priceAboveTheAverageIsAllowed() public {
        pool.set(-50_000, -49_000);
        assertEq(_buy(5e6, 0), 1_234);
    }

    function test_revertsWhenMinOutTooHigh() public {
        vm.startPrank(wallet);
        usdt.approve(address(buyer), 5e6);
        vm.expectRevert(bytes("Too little received"));
        buyer.buy(5e6, 1_235);
        vm.stopPrank();
    }

    function test_revertsWithoutApproval() public {
        vm.prank(wallet);
        vm.expectRevert(bytes("allowance"));
        buyer.buy(5e6, 0);
    }

    function test_toleratesTrailingAttributionSuffix() public {
        vm.startPrank(wallet);
        usdt.approve(address(buyer), 5e6);
        bytes memory data = bytes.concat(abi.encodeCall(GoldBuyer.buy, (5e6, 0)), TAG);
        (bool ok, bytes memory ret) = address(buyer).call(data);
        vm.stopPrank();
        assertTrue(ok, "call with suffix succeeded");
        assertEq(abi.decode(ret, (uint256)), 1_234);
    }

    function testFuzz_floorHoldsForAnyTicks(int24 average, int24 afterSwap) public {
        average = int24(bound(average, -800_000, 800_000));
        afterSwap = int24(bound(afterSwap, -887_272, 887_272));
        pool.set(average, afterSwap);
        vm.startPrank(wallet);
        usdt.approve(address(buyer), 1e6);
        if (afterSwap < average - 100) vm.expectRevert(bytes("price below TWAP floor"));
        buyer.buy(1e6, 0);
        vm.stopPrank();
    }
}
