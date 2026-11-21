// Read-only: try common view functions on an address.
import { createPublicClient, http, parseAbi } from "viem";
import { celo } from "viem/chains";
const c = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
for (const a of process.argv.slice(2)) {
  const out = { codeLen: (await c.getCode({ address: a }))?.length };
  for (const sig of ["function symbol() view returns (string)","function name() view returns (string)","function decimals() view returns (uint8)","function totalSupply() view returns (uint256)","function adaptedToken() view returns (address)","function token() view returns (address)","function getAdaptedToken() view returns (address)","function adaptee() view returns (address)","function owner() view returns (address)","function factory() view returns (address)","function token0() view returns (address)","function token1() view returns (address)","function fee() view returns (uint24)","function liquidity() view returns (uint128)","function tickSpacing() view returns (int24)"]) {
    const abi = parseAbi([sig]);
    try { out[abi[0].name] = await c.readContract({ address: a, abi, functionName: abi[0].name }); } catch {}
  }
  // EIP-1967 implementation slot
  const impl = await c.getStorageAt({ address: a, slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" });
  if (impl && BigInt(impl) !== 0n) out.eip1967Impl = "0x" + impl.slice(26);
  console.log(a, out);
}
