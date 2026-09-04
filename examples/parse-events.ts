/**
 * Fetch a submitted transaction and parse its typed contract events.
 *
 * Run: TX_HASH=... npx tsx examples/parse-events.ts
 */
import { rpc } from "@stellar/stellar-sdk";
import { TESTNET, parseContractEvents, findEvent } from "../src/index.js";

async function main() {
  const server = new rpc.Server(TESTNET.rpcUrl);
  const response = await server.getTransaction(process.env.TX_HASH!);
  if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction not successful: ${response.status}`);
  }

  // This SDK's transactions always invoke exactly one operation.
  const rawEvents = response.events?.contractEventsXdr?.[0] ?? [];
  const events = parseContractEvents(rawEvents);

  console.log(`${events.length} event(s):`);
  for (const e of events) {
    console.log(" -", e.topic, e.event);
  }

  const transfer = findEvent(events, "pay_ok");
  if (transfer) {
    console.log("pay_ok:", transfer);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
