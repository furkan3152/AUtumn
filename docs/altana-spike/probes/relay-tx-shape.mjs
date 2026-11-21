// Read-only: find recent Altana relay txs to the Celo mainnet orchestrator and show the outer calldata shape.
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
const c = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
const ORCH = "0xaf140d0416a994aebb3fa6212b16ce6700f09751";
const head = await c.getBlockNumber();
let logs = [];
for (let to = head; to > head - 100000n && logs.length === 0; to -= 1000n) {
  try { logs = await c.getLogs({ address: ORCH, fromBlock: to - 999n, toBlock: to }); } catch (e) { console.log("getLogs err", e.shortMessage); break; }
}
const hashes = [...new Set(logs.map((l) => l.transactionHash))].slice(-3);
for (const h of hashes) {
  const tx = await c.getTransaction({ hash: h });
  const inp = tx.input;
  console.log({ hash: h, type: tx.type, from: tx.from, to: tx.to, selector: inp.slice(0, 10), inputBytes: (inp.length - 2) / 2,
    last48bytes: "0x" + inp.slice(-96), endsWithMarker: inp.toLowerCase().endsWith("80218021802180218021802180218021") });
}
