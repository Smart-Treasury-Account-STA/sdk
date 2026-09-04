/**
 * Transaction-preparation helpers: prepare -> simulate -> approve. Each
 * function returns a prepared, auth-entry-attached `Transaction` --
 * simulated (fee/resource estimation) with the custom `smart_account`
 * `AuthPayload` entries already present, ready for the caller to sign the
 * envelope with a fee-paying account and submit (see `signAndSubmit`
 * below). None of these functions touch a wallet directly -- signing is
 * always an injected `Keypair | SigningCallback` (see `auth.ts`), so a
 * browser dApp can swap in a connected wallet's `signAuthEntry` without
 * changing anything here.
 *
 * Call args are hand-encoded (`transferArgs`, `splitArgs`,
 * `scheduledIntentScVal`, below) against the contracts' real signatures,
 * rather than through a generated-bindings client's
 * `.spec.funcArgsToScVals(...)` -- see `auth.ts`'s module doc comment for
 * why this SDK avoids depending on those generated bindings directly.
 */
import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  rpc,
  xdr,
  type SigningCallback,
  type Transaction,
} from "@stellar/stellar-sdk";

import { structScVal } from "./scval";
import { buildExecutorAuthEntry, buildInvocation, buildSmartAccountAuthEntries } from "./auth";
import type { NetworkConfig } from "./config";

const DEFAULT_EXPIRATION_WINDOW_LEDGERS = 100;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutes at POLL_INTERVAL_MS

function addressScVal(id: string) {
  return new Address(id).toScVal();
}

function i128ScVal(value: bigint) {
  return nativeToScVal(value, { type: "i128" });
}

function u32ScVal(value: number) {
  return nativeToScVal(value, { type: "u32" });
}

function u64ScVal(value: bigint) {
  return nativeToScVal(value, { type: "u64" });
}

function boolScVal(value: boolean) {
  return nativeToScVal(value);
}

function bytesN32ScVal(value: Buffer) {
  if (value.length !== 32) {
    throw new Error("Expected exactly 32 bytes.");
  }
  return xdr.ScVal.scvBytes(value);
}

/**
 * Builds, simulates, and returns a prepared `Transaction` invoking one
 * contract function with a given set of auth entries already attached.
 * Shared scaffolding for every `prepare*` helper below (signer-authored
 * `smart_account` calls and the relayer's `execute_scheduled_payment`
 * alike) -- only the auth entries and operation args actually differ
 * between them. Takes an already-fetched `sourceAccount` rather than
 * fetching it itself, so callers can build auth entries (a signing round
 * trip, possibly a wallet prompt) and fetch the source account
 * concurrently instead of serially.
 */
function buildAndPrepareTransaction(
  server: rpc.Server,
  net: NetworkConfig,
  sourceAccount: Account,
  contract: string,
  functionName: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[],
): Promise<Transaction> {
  const builder = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(Operation.invokeContractFunction({ contract, function: functionName, args, auth }))
    .setTimeout(120)
    .build();

  return server.prepareTransaction(builder);
}

export interface PrepareOptions {
  net: NetworkConfig;
  /** Any funded account that pays the network fee -- independent of who
   * authorizes the `smart_account` call. Only its public key is needed to
   * build the transaction. */
  feeSourceAddress: string;
  signerAddress: string;
  sign: Keypair | SigningCallback;
  contextRuleIds?: number[];
}

async function prepareSmartAccountCall(
  opts: PrepareOptions,
  functionName: string,
  args: xdr.ScVal[],
): Promise<Transaction> {
  const server = new rpc.Server(opts.net.rpcUrl);
  const latestLedger = await server.getLatestLedger();
  const signatureExpirationLedger = latestLedger.sequence + DEFAULT_EXPIRATION_WINDOW_LEDGERS;

  const rootInvocation = buildInvocation({
    contractId: opts.net.contracts.smartAccount,
    functionName,
    args,
  });

  // Neither depends on the other's result -- run the signing round trip
  // (possibly a wallet prompt) and the account-fetch RPC call concurrently
  // rather than paying both latencies serially.
  const [[entryA, entryB], sourceAccount] = await Promise.all([
    buildSmartAccountAuthEntries({
      smartAccountId: opts.net.contracts.smartAccount,
      rootInvocation,
      signerAddress: opts.signerAddress,
      sign: opts.sign,
      networkPassphrase: opts.net.networkPassphrase,
      contextRuleIds: opts.contextRuleIds,
      signatureExpirationLedger,
    }),
    server.getAccount(opts.feeSourceAddress),
  ]);

  return buildAndPrepareTransaction(
    server,
    opts.net,
    sourceAccount,
    opts.net.contracts.smartAccount,
    functionName,
    args,
    [entryA, entryB],
  );
}

export interface TransferPaymentArgs {
  asset: string;
  destination: string;
  amount: bigint;
  nonce: bigint;
  expectedPolicyVersion: number;
}

export async function prepareTransferPayment(
  opts: PrepareOptions,
  payment: TransferPaymentArgs,
): Promise<Transaction> {
  const args = [
    addressScVal(payment.asset),
    addressScVal(payment.destination),
    i128ScVal(payment.amount),
    u64ScVal(payment.nonce),
    u32ScVal(payment.expectedPolicyVersion),
  ];
  return prepareSmartAccountCall(opts, "execute_transfer_payment", args);
}

export interface SplitPaymentArgs {
  asset: string;
  recipients: string[];
  amounts: bigint[];
  nonce: bigint;
  expectedPolicyVersion: number;
}

export async function prepareSplitPayment(
  opts: PrepareOptions,
  payment: SplitPaymentArgs,
): Promise<Transaction> {
  const args = [
    addressScVal(payment.asset),
    xdr.ScVal.scvVec(payment.recipients.map(addressScVal)),
    xdr.ScVal.scvVec(payment.amounts.map(i128ScVal)),
    u64ScVal(payment.nonce),
    u32ScVal(payment.expectedPolicyVersion),
  ];
  return prepareSmartAccountCall(opts, "execute_split_payment", args);
}

export interface ScheduledIntentArgs {
  intent_id: Buffer;
  asset: string;
  destination: string;
  amount: bigint;
  start_ledger: number;
  end_ledger: number;
  interval_ledgers: number;
  max_executions: number;
  /** Ignored/overwritten server-side, pinned to `0` at creation -- pass any
   * placeholder value; read the resolved field back from the
   * `IntentCreated` event or a follow-up `get_intent` read. */
  execution_count: number;
  /** Ignored/overwritten server-side, pinned to `policy_engine.version()`
   * at creation time -- see `execution_count` above. */
  policy_version: number;
  /** Ignored/overwritten server-side, pinned to the currently configured
   * `transfer_adapter` at creation time -- see `execution_count` above. */
  adapter: string;
  cancelled: boolean;
}

function scheduledIntentScVal(intent: ScheduledIntentArgs) {
  return structScVal({
    intent_id: bytesN32ScVal(intent.intent_id),
    asset: addressScVal(intent.asset),
    destination: addressScVal(intent.destination),
    amount: i128ScVal(intent.amount),
    start_ledger: u32ScVal(intent.start_ledger),
    end_ledger: u32ScVal(intent.end_ledger),
    interval_ledgers: u32ScVal(intent.interval_ledgers),
    max_executions: u32ScVal(intent.max_executions),
    execution_count: u32ScVal(intent.execution_count),
    policy_version: u32ScVal(intent.policy_version),
    adapter: addressScVal(intent.adapter),
    cancelled: boolScVal(intent.cancelled),
  });
}

/** `intent`'s caller-supplied `policy_version`/`adapter` are ignored and
 * overwritten by the contract (pinned to current values at approval time)
 * -- pass any placeholder value; read the resolved fields back from the
 * `IntentCreated` event or a follow-up `get_intent` read. */
export async function prepareScheduledPayment(
  opts: PrepareOptions,
  intent: ScheduledIntentArgs,
): Promise<Transaction> {
  const args = [scheduledIntentScVal(intent)];
  return prepareSmartAccountCall(opts, "create_scheduled_payment", args);
}

export async function prepareCancelScheduledPayment(
  opts: PrepareOptions,
  intentId: Buffer,
): Promise<Transaction> {
  const args = [bytesN32ScVal(intentId)];
  return prepareSmartAccountCall(opts, "cancel_scheduled_payment", args);
}

/** Signs the transaction envelope with the fee-paying account's key
 * (independent of the `smart_account` auth entries, already attached by
 * `prepare*`) and submits it, polling until a terminal status. */
export async function signAndSubmit(
  net: NetworkConfig,
  tx: Transaction,
  feeSourceKeypair: Keypair,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const server = new rpc.Server(net.rpcUrl);
  tx.sign(feeSourceKeypair);
  const sendResponse = await server.sendTransaction(tx);
  if (sendResponse.status === "ERROR") {
    throw new Error(`sendTransaction failed: ${JSON.stringify(sendResponse.errorResult)}`);
  }

  let response = await server.getTransaction(sendResponse.hash);
  for (
    let attempt = 0;
    response.status === rpc.Api.GetTransactionStatus.NOT_FOUND && attempt < MAX_POLL_ATTEMPTS;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    response = await server.getTransaction(sendResponse.hash);
  }
  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new Error(
      `transaction ${sendResponse.hash} not found after ${MAX_POLL_ATTEMPTS} polling attempts`,
    );
  }
  if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sendResponse.hash} failed: ${JSON.stringify(response)}`);
  }
  return response;
}

export interface RelayerExecuteOptions {
  net: NetworkConfig;
  intentId: Buffer;
  childSequence: number;
  executorAddress: string;
  sign: Keypair | SigningCallback;
}

/**
 * Prepares a relayer's `execute_scheduled_payment` call. Unlike the
 * signer-authored payment helpers above, this needs no `smart_account`
 * `AuthPayload` at all -- only an explicit authorization entry for
 * `intent_registry.mark_child_executed`'s `Executor` requirement (see
 * `buildExecutorAuthEntry`'s doc comment in `auth.ts`).
 */
export async function prepareRelayerExecution(opts: RelayerExecuteOptions): Promise<Transaction> {
  const server = new rpc.Server(opts.net.rpcUrl);
  const latestLedger = await server.getLatestLedger();
  const signatureExpirationLedger = latestLedger.sequence + DEFAULT_EXPIRATION_WINDOW_LEDGERS;

  const [executorEntry, sourceAccount] = await Promise.all([
    buildExecutorAuthEntry({
      intentRegistryId: opts.net.contracts.intentRegistry,
      intentId: opts.intentId,
      childSequence: opts.childSequence,
      executorAddress: opts.executorAddress,
      sign: opts.sign,
      networkPassphrase: opts.net.networkPassphrase,
      signatureExpirationLedger,
    }),
    server.getAccount(opts.executorAddress),
  ]);

  const args = [bytesN32ScVal(opts.intentId), u32ScVal(opts.childSequence)];
  return buildAndPrepareTransaction(
    server,
    opts.net,
    sourceAccount,
    opts.net.contracts.smartAccount,
    "execute_scheduled_payment",
    args,
    [executorEntry],
  );
}

export { Account };
