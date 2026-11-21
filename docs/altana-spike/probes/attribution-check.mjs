// Read-only: run @celo/attribution-tags' own checker on real Altana relay txs (Celo mainnet), and show where a
// tag appended to an inner session call's data would sit in the outer calldata.
import { verifyTx, fromDataSuffix, toDataSuffix } from "@celo/attribution-tags";
import * as attr from "@celo/attribution-tags";
import { createPublicClient, http, encodeFunctionData, parseAbi, concat, encodeAbiParameters, decodeFunctionData } from "viem";
import { celo } from "viem/chains";
const c = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
const TAG = toDataSuffix("celo_c24c5a65e5a3");
const MARK = "80218021802180218021802180218021";
const txs = ["0x2226464a8499c60bbf80bb96e8f8432b938f976f84ca2148fbed4b8cb059f95d","0x37c107dbe9efcfa20ffe56d179045c2ac29dae9cd16d16f094bcf3c4355513db","0xe43b71c664d21366a2f832d5fed97b4a0293055cc7558e66ef24565685453e08"];
console.log("exports:", Object.keys(attr).join(", "));
for (const hash of txs) {
  const tx = await c.getTransaction({ hash });
  const { args } = decodeFunctionData({ abi: parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4)"]), data: tx.input });
  const intentLen = (args[0].length - 2) / 2;
  const hasTransferSel = tx.input.includes("a9059cbb");
  console.log(hash, { verifyTx: await verifyTx({ client: c, hash }), fromDataSuffix: fromDataSuffix(tx.input), encodedIntentBytes: intentLen, innerTransferSelectorPresent: hasTransferSel, markerAnywhere: tx.input.includes(MARK) });
}
// Model: a session call whose data = transfer calldata ++ TAG, wrapped the way the account's ERC-7821 executionData
// wraps calls (abi.encode(Call[])), and then as the bytes arg of Orchestrator.execute(bytes).
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const inner = concat([encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: ["0x000000000000000000000000000000000000dEaD", 1n] }), TAG]);
const executionData = encodeAbiParameters([{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], [[{ to: USDT, value: 0n, data: inner }]]);
const outer = encodeFunctionData({ abi: parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4)"]), functionName: "execute", args: [executionData] });
const pos = outer.indexOf(MARK);
console.log("model: inner call ends with tag:", JSON.stringify(fromDataSuffix(inner)));
console.log("model: outer (even in this best case with nothing after executionData) parses as:", JSON.stringify(fromDataSuffix(outer)), "- marker at byte", (pos - 2) / 2, "of", (outer.length - 2) / 2, "; trailing bytes after marker:", (outer.length - pos - MARK.length) / 2);
