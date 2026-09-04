/**
 * Prepare, sign, and submit a single transfer payment from a Smart
 * Treasury Account on testnet.
 *
 * Run: SIGNER_SECRET=S... FEE_SOURCE_SECRET=S... npx tsx examples/transfer.ts
 */
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, prepareTransferPayment, signAndSubmit, readPolicyVersion } from "../src/index.js";

async function main() {
  const signer = Keypair.fromSecret(process.env.SIGNER_SECRET!);
  const feeSource = Keypair.fromSecret(process.env.FEE_SOURCE_SECRET ?? process.env.SIGNER_SECRET!);

  const expectedPolicyVersion = await readPolicyVersion(TESTNET, feeSource.publicKey());

  const tx = await prepareTransferPayment(
    {
      net: TESTNET,
      feeSourceAddress: feeSource.publicKey(),
      signerAddress: signer.publicKey(),
      sign: signer,
    },
    {
      asset: TESTNET.contracts.smartAccount, // replace with the real asset contract id
      destination: "GDESTINATION...",
      amount: 100_0000000n, // 10 XLM at 7 decimals
      nonce: BigInt(Date.now()), // any nonce not previously consumed on this account
      expectedPolicyVersion,
    },
  );

  const result = await signAndSubmit(TESTNET, tx, feeSource);
  console.log("submitted, ledger:", result.ledger);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
