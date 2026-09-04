/**
 * First-class typed reads for policy-version, replay-state (nonce), and
 * recovery-state. Every function here is a read-only simulation (no
 * signature, no submission), built directly on
 * `rpc.Server.simulateTransaction` rather than a generated per-contract
 * `Client` -- see `auth.ts`'s module doc comment for why this SDK avoids
 * depending on generated bindings directly. One consequence: every
 * function here takes an explicit `sourceAddress` (a real, funded account
 * to build the simulation transaction from -- `getAccount` fails for one
 * that doesn't exist on-chain).
 *
 * Every type below (`AccountStatus`, `ContextRule`, `ScheduledIntent`,
 * `RecoveryRequest`, `WasmHashes`) is verified directly against the real
 * `#[contracttype]` struct definitions in the source contracts (and the
 * `stellar-accounts` OZ crate for `ContextRule`), not reconstructed from
 * observed JSON shapes.
 */
import { Contract, TransactionBuilder, BASE_FEE, rpc, scValToNative, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "./config";

export interface AccountStatus {
  initialized: boolean;
  paused: boolean;
  frozen: boolean;
  policy_version_hint: number;
}

/** From the vendored `stellar-accounts` OZ crate
 * (`smart_account::storage::ContextRule`), not this workspace's own
 * contracts -- `get_context_rule`'s actual return type. */
export interface ContextRule {
  id: number;
  context_type: string;
  name: string;
  signers: unknown[];
  signer_ids: number[];
  policies: string[];
  policy_ids: number[];
  valid_until?: number;
}

export interface ScheduledIntent {
  intent_id: Buffer;
  asset: string;
  destination: string;
  amount: bigint;
  start_ledger: number;
  end_ledger: number;
  interval_ledgers: number;
  max_executions: number;
  execution_count: number;
  policy_version: number;
  adapter: string;
  cancelled: boolean;
}

export interface RecoveryRequest {
  request_id: Buffer;
  replacement_owner: string;
  replacement_signers: unknown[];
  replacement_policies: Record<string, unknown>;
  earliest_ledger: number;
  approvers: string[];
  cancelled: boolean;
  finalized: boolean;
}

export interface WasmHashes {
  policy_engine: Buffer;
  intent_registry: Buffer;
  recovery_manager: Buffer;
  transfer_adapter: Buffer;
  split_adapter: Buffer;
  smart_account: Buffer;
}

function isSimulationError(
  simulation: rpc.Api.SimulateTransactionResponse,
): simulation is rpc.Api.SimulateTransactionErrorResponse {
  return "error" in simulation;
}

async function simulateRead(
  net: NetworkConfig,
  sourceAddress: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const server = new rpc.Server(net.rpcUrl);
  const source = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (isSimulationError(simulation)) {
    throw new Error(simulation.error);
  }
  return simulation.result?.retval ? scValToNative(simulation.result.retval) : null;
}

function u32ScVal(value: number) {
  return nativeToScVal(value, { type: "u32" });
}

function u64ScVal(value: bigint) {
  return nativeToScVal(value, { type: "u64" });
}

function bytesN32ScVal(value: Buffer) {
  if (value.length !== 32) {
    throw new Error("Expected exactly 32 bytes.");
  }
  return xdr.ScVal.scvBytes(value);
}

function addressScVal(value: string) {
  return nativeToScVal(value, { type: "address" });
}

/** `smart_account.status()` -- check before offering any payment action; a
 * paused or frozen treasury should disable the payment UI, not let the
 * user hit a rejected simulation. */
export async function readAccountStatus(
  net: NetworkConfig,
  sourceAddress: string,
): Promise<AccountStatus> {
  return (await simulateRead(net, sourceAddress, net.contracts.smartAccount, "status")) as AccountStatus;
}

export async function readOwner(net: NetworkConfig, sourceAddress: string): Promise<string | null> {
  const result = await simulateRead(net, sourceAddress, net.contracts.smartAccount, "get_owner");
  return typeof result === "string" ? result : null;
}

/** Rule IDs are `0..count`, not necessarily contiguous after removals --
 * check existence with `readContextRule`, don't assume. */
export async function readContextRulesCount(net: NetworkConfig, sourceAddress: string): Promise<number> {
  const result = await simulateRead(net, sourceAddress, net.contracts.smartAccount, "get_context_rules_count");
  return Number(result ?? 0);
}

export async function readContextRule(
  net: NetworkConfig,
  sourceAddress: string,
  contextRuleId: number,
): Promise<ContextRule> {
  return (await simulateRead(net, sourceAddress, net.contracts.smartAccount, "get_context_rule", [
    u32ScVal(contextRuleId),
  ])) as ContextRule;
}

export async function isNonceUsed(net: NetworkConfig, sourceAddress: string, nonce: bigint): Promise<boolean> {
  const result = await simulateRead(net, sourceAddress, net.contracts.smartAccount, "is_nonce_used", [
    u64ScVal(nonce),
  ]);
  return Boolean(result);
}

/** The authoritative current policy version -- read fresh immediately
 * before building a payment, never cached across a user session (a stale
 * value here causes a clean `VersionMismatch` rejection rather than
 * executing under outdated rules). */
export async function readPolicyVersion(net: NetworkConfig, sourceAddress: string): Promise<number> {
  const result = await simulateRead(net, sourceAddress, net.contracts.policyEngine, "version");
  return Number(result ?? 1);
}

export async function readScheduledIntent(
  net: NetworkConfig,
  sourceAddress: string,
  intentId: Buffer,
): Promise<ScheduledIntent> {
  return (await simulateRead(net, sourceAddress, net.contracts.intentRegistry, "get_intent", [
    bytesN32ScVal(intentId),
  ])) as ScheduledIntent;
}

export async function isChildExecuted(
  net: NetworkConfig,
  sourceAddress: string,
  intentId: Buffer,
  childSequence: number,
): Promise<boolean> {
  const result = await simulateRead(net, sourceAddress, net.contracts.intentRegistry, "is_child_executed", [
    bytesN32ScVal(intentId),
    u32ScVal(childSequence),
  ]);
  return Boolean(result);
}

/** Recovery-request state -- first-class typed state, not a raw XDR blob. */
export async function readRecoveryRequest(
  net: NetworkConfig,
  sourceAddress: string,
  requestId: Buffer,
): Promise<RecoveryRequest> {
  return (await simulateRead(net, sourceAddress, net.contracts.recoveryManager, "request_status", [
    bytesN32ScVal(requestId),
  ])) as RecoveryRequest;
}

export async function readLiveApprovalCount(
  net: NetworkConfig,
  sourceAddress: string,
  requestId: Buffer,
): Promise<number> {
  const result = await simulateRead(net, sourceAddress, net.contracts.recoveryManager, "live_approval_count", [
    bytesN32ScVal(requestId),
  ]);
  return Number(result ?? 0);
}

export async function isGuardian(
  net: NetworkConfig,
  sourceAddress: string,
  guardian: string,
): Promise<boolean> {
  const result = await simulateRead(net, sourceAddress, net.contracts.recoveryManager, "is_guardian", [
    addressScVal(guardian),
  ]);
  return Boolean(result);
}

/** Monotonically increasing, never-cleared -- compare against a locally
 * stored "last applied" value to detect a pending guardian freeze rather
 * than treating this as a boolean. */
export async function readGuardianFreezeEpoch(net: NetworkConfig, sourceAddress: string): Promise<number> {
  const result = await simulateRead(net, sourceAddress, net.contracts.recoveryManager, "guardian_freeze_epoch");
  return Number(result ?? 0);
}

export async function readFactoryWasmHashes(net: NetworkConfig, sourceAddress: string): Promise<WasmHashes> {
  return (await simulateRead(
    net,
    sourceAddress,
    net.contracts.accountFactory,
    "get_wasm_hashes",
  )) as WasmHashes;
}
