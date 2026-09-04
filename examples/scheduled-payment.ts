/**
 * Create a scheduled (recurring) payment, then cancel it.
 *
 * Run: SIGNER_SECRET=S... FEE_SOURCE_SECRET=S... npx tsx examples/scheduled-payment.ts
 */
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  TESTNET,
  prepareScheduledPayment,
  prepareCancelScheduledPayment,
  signAndSubmit,
} from "../src/index.js";

async function main() {
  const signer = Keypair.fromSecret(process.env.SIGNER_SECRET!);
  const feeSource = Keypair.fromSecret(process.env.FEE_SOURCE_SECRET ?? process.env.SIGNER_SECRET!);

  const intentId = randomBytes(32);
  const opts = {
    net: TESTNET,
    feeSourceAddress: feeSource.publicKey(),
    signerAddress: signer.publicKey(),
    sign: signer,
  };

  const createTx = await prepareScheduledPayment(opts, {
    intent_id: intentId,
    asset: TESTNET.contracts.smartAccount, // replace with the real asset contract id
    destination: "GDESTINATION...",
    amount: 10_0000000n,
    start_ledger: 0, // 0 = starts immediately at the current ledger
    end_ledger: 0, // 0 = no end
    interval_ledgers: 17280, // ~1 day at 5s/ledger
    max_executions: 5,
    execution_count: 0, // ignored/overwritten server-side, see field doc comment
    policy_version: 0, // ignored/overwritten server-side, see field doc comment
    adapter: TESTNET.contracts.transferAdapter, // ignored/overwritten server-side, see field doc comment
    cancelled: false,
  });
  const createResult = await signAndSubmit(TESTNET, createTx, feeSource);
  console.log("created, ledger:", createResult.ledger);

  // Later, to stop it before max_executions is reached:
  const cancelTx = await prepareCancelScheduledPayment(opts, intentId);
  const cancelResult = await signAndSubmit(TESTNET, cancelTx, feeSource);
  console.log("cancelled, ledger:", cancelResult.ledger);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
