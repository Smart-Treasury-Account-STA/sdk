/**
 * Prepare, sign, and submit a split payment (one asset, multiple
 * recipients, matching amounts) from a Smart Treasury Account on testnet.
 *
 * Run: SIGNER_SECRET=S... FEE_SOURCE_SECRET=S... npx tsx examples/split-payment.ts
 */
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, prepareSplitPayment, signAndSubmit, readPolicyVersion } from "../src/index.js";

async function main() {
  const signer = Keypair.fromSecret(process.env.SIGNER_SECRET!);
  const feeSource = Keypair.fromSecret(process.env.FEE_SOURCE_SECRET ?? process.env.SIGNER_SECRET!);

  const expectedPolicyVersion = await readPolicyVersion(TESTNET, feeSource.publicKey());

  const tx = await prepareSplitPayment(
    {
      net: TESTNET,
      feeSourceAddress: feeSource.publicKey(),
      signerAddress: signer.publicKey(),
      sign: signer,
    },
    {
      asset: TESTNET.contracts.smartAccount, // replace with the real asset contract id
      recipients: ["GRECIPIENT_ONE...", "GRECIPIENT_TWO..."],
      amounts: [50_0000000n, 50_0000000n],
      nonce: BigInt(Date.now()),
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
