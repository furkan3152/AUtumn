// Read-only: find ERC-8021 markers embedded mid-calldata in Altana relay txs and decode the tag ending at each.
import { fromDataSuffix } from "@celo/attribution-tags";
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
const c = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
const MARK = "80218021802180218021802180218021";
for (const hash of process.argv.slice(2)) {
  const tx = await c.getTransaction({ hash });
  const hex = tx.input.slice(2);
  let i = -1;
  while ((i = hex.indexOf(MARK, i + 1)) !== -1) {
    if (i % 2) continue;
    const slice = "0x" + hex.slice(0, i + MARK.length);
    console.log(hash, { markerByteOffset: i / 2, inputBytes: hex.length / 2, bytesAfterMarker: (hex.length - i - MARK.length) / 2, decoded: fromDataSuffix(slice) });
  }
}
