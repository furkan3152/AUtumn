/**
 * Celo's own ERC-8021 checks (@celo/attribution-tags), re-exported so the
 * agent can verify a transaction with exactly the code Celo's indexer uses.
 */
export { fromDataSuffix, verifyTx } from "@celo/attribution-tags";
