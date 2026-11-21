// Read-only: resolve FeeCurrencyDirectory via the Celo Registry and list fee currencies with symbols.
import { createPublicClient, http, parseAbi } from "viem";
import { celo } from "viem/chains";
const c = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
const reg = parseAbi(["function getAddressForString(string) view returns (address)"]);
const dir = await c.readContract({ address: "0x000000000000000000000000000000000000ce10", abi: reg, functionName: "getAddressForString", args: ["FeeCurrencyDirectory"] });
console.log("FeeCurrencyDirectory", dir);
const fcd = parseAbi(["function getCurrencies() view returns (address[])"]);
const list = await c.readContract({ address: dir, abi: fcd, functionName: "getCurrencies" });
const erc = parseAbi(["function symbol() view returns (string)","function name() view returns (string)","function decimals() view returns (uint8)","function adaptedToken() view returns (address)","function totalSupply() view returns (uint256)"]);
for (const a of list) {
  let sym, name, dec, adapted;
  try { sym = await c.readContract({address:a,abi:erc,functionName:"symbol"}); } catch {}
  try { adapted = await c.readContract({address:a,abi:erc,functionName:"adaptedToken"}); } catch {}
  const t = adapted ?? a;
  try { sym = await c.readContract({address:t,abi:erc,functionName:"symbol"}); name = await c.readContract({address:t,abi:erc,functionName:"name"}); dec = await c.readContract({address:t,abi:erc,functionName:"decimals"}); } catch {}
  if (/xau|gold/i.test(`${sym} ${name}`) || /USD/.test(sym ?? "")) console.log(a, adapted ? `adapter-> ${adapted}` : "", sym, name, dec, adapted ? "" : "");
}
