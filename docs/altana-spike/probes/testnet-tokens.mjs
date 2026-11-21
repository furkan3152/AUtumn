import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem";
import { celoSepolia } from "viem/chains";
const c = createPublicClient({ chain: celoSepolia, transport: http("https://forno.celo-sepolia.celo-testnet.org") });
const me = "0xED58Da0B13bF9f63c3608F9068d488559cDCAA51";
for (const t of ["0xd077A400968890Eacc75cdc901F0356c943e4fDb","0x01C5C0122039549AD1493B8220cABEdD739BC44E"]) {
  const abi = parseAbi(["function name() view returns (string)","function symbol() view returns (string)","function decimals() view returns (uint8)","function totalSupply() view returns (uint256)","function balanceOf(address) view returns (uint256)"]);
  const r = {};
  for (const f of ["name","symbol","decimals","totalSupply"]) { try { r[f] = await c.readContract({address:t,abi,functionName:f}); } catch(e){ r[f]="err"; } }
  r.bal = await c.readContract({address:t,abi,functionName:"balanceOf",args:[me]});
  const code = await c.getCode({address:t}); r.codeLen = code?.length;
  for (const sig of ["function mint(address,uint256)","function faucet()","function drip()","function mint(uint256)"]) {
    const a = parseAbi([sig]); const fn = a[0].name;
    const args = a[0].inputs.length===2?[me,1000000n]:a[0].inputs.length===1?[1000000n]:[];
    try { await c.call({account: me, to:t, data: encodeFunctionData({abi:a,functionName:fn,args})}); r[sig]="call OK (simulated)"; } catch(e){ r[sig]="revert: "+(e.shortMessage||e.message).slice(0,80); }
  }
  console.log(t, r);
}
console.log("CELO bal", await c.getBalance({address: me}));
