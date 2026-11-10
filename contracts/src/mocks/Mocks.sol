// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

/// @notice Minimal mintable ERC20 for testnets and tests.
contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Oracles below expose `price(address) -> WAD`, the interface the compound-v2-style adapter expects.
/// @notice Fixed-price oracle (stands in for Chainlink in demos). Anyone can set — demo/test only.
contract MockPriceOracle {
    mapping(address => uint256) public prices;

    function setPrice(address asset, uint256 p) external {
        prices[asset] = p;
    }

    function price(address asset) external view returns (uint256) {
        return prices[asset];
    }
}

/// @notice Thin constant-product pool used as a spot oracle — the classic manipulable price source
///         (Tectonic / Moonwell pattern). price = baseReserve / tokenReserve, normalised to WAD.
contract MockAMMOracle {
    IERC20 public immutable base;
    IERC20 public immutable token;
    uint8 public immutable baseDecimals;
    uint8 public immutable tokenDecimals;
    uint256 public reserveBase;
    uint256 public reserveToken;

    constructor(address base_, address token_, uint8 bd, uint8 td) {
        base = IERC20(base_);
        token = IERC20(token_);
        baseDecimals = bd;
        tokenDecimals = td;
    }

    function seed(uint256 baseAmount, uint256 tokenAmount) external {
        base.transferFrom(msg.sender, address(this), baseAmount);
        token.transferFrom(msg.sender, address(this), tokenAmount);
        reserveBase += baseAmount;
        reserveToken += tokenAmount;
    }

    /// @notice Swap base in, token out (pumps the token price).
    function swapBaseForToken(uint256 baseIn) external returns (uint256 out) {
        base.transferFrom(msg.sender, address(this), baseIn);
        out = (reserveToken * baseIn) / (reserveBase + baseIn);
        reserveBase += baseIn;
        reserveToken -= out;
        token.transfer(msg.sender, out);
    }

    /// @notice Swap token in, base out (dumps the token price).
    function swapTokenForBase(uint256 tokenIn) external returns (uint256 out) {
        token.transferFrom(msg.sender, address(this), tokenIn);
        out = (reserveBase * tokenIn) / (reserveToken + tokenIn);
        reserveToken += tokenIn;
        reserveBase -= out;
        base.transfer(msg.sender, out);
    }

    function price(address) external view returns (uint256) {
        if (reserveToken == 0) return 0;
        return (reserveBase * 1e18 * (10 ** tokenDecimals)) / (reserveToken * (10 ** baseDecimals));
    }
}
