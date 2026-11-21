// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory);
    function slot0() external view returns (uint160, int24 tick, uint16, uint16, uint16, uint8, bool);
}

/// @title GoldBuyer
/// @notice Swaps the caller's USD₮ for Tether Gold (XAUt0) on Celo and sends the gold straight back to the caller.
/// @dev No owner, no admin, no storage, no upgrade path. Every address and limit is a constant.
///      An agent session key can be allowed to call `buy` without being able to choose the token,
///      the pool or the recipient, and without being able to accept a manipulated price.
contract GoldBuyer {
    IERC20 public constant USDT = IERC20(0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e);
    address public constant XAUT0 = 0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff;
    IUniswapV3Pool public constant POOL = IUniswapV3Pool(0xbb469A28f64C72aECC7d05Ca6e45B2FB1a63B4F9);
    ISwapRouter02 public constant ROUTER = ISwapRouter02(0x5615CDAb10dc425a742d643d949a7F474C01abc4);
    uint24 public constant FEE = 3000; // the 0.3% USD₮/XAUt0 pool above

    /// @notice Length of the average price the swap is checked against.
    uint32 public constant TWAP_WINDOW = 30 minutes;
    /// @notice How far the pool price may end up below that average: 100 ticks, about 1%.
    int24 public constant MAX_TICK_DROP = 100;

    event Bought(address indexed buyer, uint256 amountIn, uint256 out);

    /// @notice Buy XAUt0 with `amountIn` USD₮ from the caller, who must have approved this contract first.
    /// @param amountIn USD₮ to spend (6 decimals).
    /// @param minOut The least XAUt0 (6 decimals) the caller accepts.
    /// @return out XAUt0 delivered to the caller.
    /// @dev Price floor that does not trust the caller: buying gold moves the pool price down, so the
    ///      average price paid is never worse than the price after the swap. Requiring that final price
    ///      to be within MAX_TICK_DROP of the 30-minute average means the caller receives at least the
    ///      average-price quote minus the 0.3% pool fee and about 1%. Reverts if the pool cannot
    ///      report a 30-minute average (too little observation history), so it fails closed.
    function buy(uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        (int56[] memory cumulative,) = POOL.observe(ago);
        int24 averageTick = int24((cumulative[1] - cumulative[0]) / int56(uint56(TWAP_WINDOW)));

        require(USDT.transferFrom(msg.sender, address(this), amountIn), "transferFrom failed");
        require(USDT.approve(address(ROUTER), amountIn), "approve failed");
        out = ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(address(USDT), XAUT0, FEE, msg.sender, amountIn, minOut, 0)
        );
        require(USDT.approve(address(ROUTER), 0), "approve reset failed");

        (, int24 tickAfter,,,,,) = POOL.slot0();
        require(tickAfter >= averageTick - MAX_TICK_DROP, "price below TWAP floor");
        emit Bought(msg.sender, amountIn, out);
    }
}
