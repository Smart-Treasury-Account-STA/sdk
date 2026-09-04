/**
 * `smart_account`'s custom-account authorization: "Entry A" / "Entry B"
 * construction ("sta-sdk").
 *
 * Deliberately does not depend on the Stellar CLI's generated per-contract
 * bindings (`stellar contract bindings typescript`) for this encoding:
 * those bindings pin to a specific `@stellar/stellar-sdk` major, and
 * loading a second major of the same classes (`Address`, `xdr.ScVal`, ...)
 * in a consumer's bundle risks `instanceof` mismatches between them. This
 * module hand-encodes the `AuthPayload` struct shape directly instead
 * (`smartAccountAuthPayloadScVal` below), verified against the real
 * `#[contracttype]` definition (`{ signers: Map<Signer, Bytes>,
 * context_rule_ids: Vec<u32> }`) rather than derived from a generated
 * client's `Spec`.
 *
 * `smart_account` implements Soroban's `CustomAccountInterface`
 * (`__check_auth`), composed from OpenZeppelin's `stellar-accounts` crate.
 * Any call that does `env.current_contract_address().require_auth()` --
 * every fund-moving or schedule-creating entrypoint -- needs the
 * transaction to carry a `SorobanAuthorizationEntry` whose
 * `credentials.signature` is not a signature at all, but a
 * contract-defined `AuthPayload` struct.
 *
 * Two entries are required per required `Signer::Delegated` signer:
 *
 * - **Entry A** (once, for `smart_account` itself): the `AuthPayload`
 *   structure -- no wallet interaction, assembled directly from the
 *   caller-supplied context rule id(s).
 * - **Entry B** (one per required signer): a standard classic-account
 *   authorization entry for the nested
 *   `addr.require_auth_for_args((auth_digest,))` call -- this is what a
 *   wallet (or a raw `Keypair`, server-side) actually signs, via
 *   `@stellar/stellar-sdk`'s own `authorizeEntry`.
 */
import { Address, hash, Keypair, xdr, type SigningCallback } from "@stellar/stellar-sdk";
import { authorizeEntry } from "@stellar/stellar-sdk";

import { structScVal } from "./scval";

export interface SubInvocationSpec {
  contractId: string;
  functionName: string;
  args: xdr.ScVal[];
  subInvocations?: xdr.SorobanAuthorizedInvocation[];
}

export function buildInvocation(spec: SubInvocationSpec): xdr.SorobanAuthorizedInvocation {
  const fn = new xdr.InvokeContractArgs({
    contractAddress: new Address(spec.contractId).toScAddress(),
    functionName: spec.functionName,
    args: spec.args,
  });
  const func = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(fn);
  return new xdr.SorobanAuthorizedInvocation({
    function: func,
    subInvocations: spec.subInvocations ?? [],
  });
}

function networkId(networkPassphrase: string): Buffer {
  return hash(Buffer.from(networkPassphrase));
}

/** The standard Soroban authorization-entry signature payload: the hash of
 * the `HashIdPreimage::SorobanAuthorization` preimage over a given
 * invocation, nonce, and expiration ledger. Every `Address` credential
 * (custom-account or classic) signs a value derived from this. */
export function signaturePayload(
  invocation: xdr.SorobanAuthorizedInvocation,
  nonce: bigint,
  signatureExpirationLedger: number,
  networkPassphrase: string,
): Buffer {
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: networkId(networkPassphrase),
      nonce: xdr.Int64.fromString(nonce.toString()),
      signatureExpirationLedger,
      invocation,
    }),
  );
  return hash(preimage.toXDR());
}

function randomNonce(): bigint {
  // 62-bit random nonce, matching the upstream SDK's scripts/execute_signer_authorized_call.py.
  const high = BigInt(Math.floor(Math.random() * 2 ** 30));
  const low = BigInt(Math.floor(Math.random() * 2 ** 32));
  return (high << 32n) | low;
}

/**
 * Builds and signs one ordinary classic-account `SorobanAuthorizationEntry`
 * -- an `Address` credential whose signature is a real Ed25519 signature
 * (via `authorizeEntry`), not a contract-defined payload like
 * `smart_account`'s `AuthPayload`. Shared by Entry B of
 * `buildSmartAccountAuthEntries` (the nested `__check_auth` call a
 * `Signer::Delegated` wallet signs) and `buildExecutorAuthEntry` (the
 * relayer's `mark_child_executed` authorization) -- both are the same
 * mechanism pointed at a different invocation/address.
 */
async function buildClassicAuthEntry(
  address: string,
  invocation: xdr.SorobanAuthorizedInvocation,
  sign: Keypair | SigningCallback,
  signatureExpirationLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  const nonce = randomNonce();
  const unsignedEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  });
  return authorizeEntry(unsignedEntry, sign, signatureExpirationLedger, networkPassphrase);
}

/** Encodes `smart_account`'s `AuthPayload { signers: Map<Signer, Bytes>,
 * context_rule_ids: Vec<u32> }` directly against the contract's known
 * struct shape -- see this module's doc comment for why this replaces
 * upstream's `spec.nativeToScVal` call. `Signer::Delegated(address)` is
 * the enum variant encoding (a two-element vector: the variant's symbol,
 * then its payload) every delegated-signer call in this workspace uses;
 * the signature bytes are empty because `do_check_auth` does not check
 * them for a delegated signer (the wallet's classic signature on Entry B
 * is what's actually verified). */
function smartAccountAuthPayloadScVal(signerAddress: string, contextRuleIdsScVal: xdr.ScVal): xdr.ScVal {
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    new Address(signerAddress).toScVal(),
  ]);
  const signersMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: signerKey, val: xdr.ScVal.scvBytes(Buffer.alloc(0)) }),
  ]);
  return structScVal({
    context_rule_ids: contextRuleIdsScVal,
    signers: signersMap,
  });
}

export interface BuildSmartAccountAuthOptions {
  smartAccountId: string;
  /** The actual `smart_account` call being authorized (its root
   * invocation) -- e.g. `execute_transfer_payment(...)`. Declare any
   * further sub-invocations that must be pre-cleared by this SAME entry
   * as its `subInvocations`. */
  rootInvocation: xdr.SorobanAuthorizedInvocation;
  /** G-address of the `Signer::Delegated` wallet authorizing this call. */
  signerAddress: string;
  /** Signs Entry B's classic authorization entry -- a raw `Keypair` for
   * server-side use, or a `SigningCallback` forwarding to a connected
   * wallet's `signAuthEntry`. */
  sign: Keypair | SigningCallback;
  networkPassphrase: string;
  /** Context rule id(s) the signer is registered under, one per auth
   * context reaching `__check_auth` (root + any declared
   * sub-invocation). Default: `[0]` (the founding rule), applied to every
   * context. */
  contextRuleIds?: number[];
  signatureExpirationLedger: number;
}

/**
 * Builds Entry A + Entry B for a single required `Signer::Delegated`.
 *
 * KNOWN ISSUE: for a multi-signer context rule (threshold > 1), calling
 * this once per signer and attaching each pair produces N separate
 * Entry As, each with a single-key `signers` map. That does not match
 * `DAPP_INTEGRATION_SPEC.md` §5.4, which specifies one shared Entry A
 * carrying all N signers' keys plus N Entry Bs (one per signer) collected
 * against that same Entry A over time. Multi-signer callers should not
 * rely on this function as-is until that's reconciled -- track before
 * shipping real M-of-N threshold support.
 */
export async function buildSmartAccountAuthEntries(
  opts: BuildSmartAccountAuthOptions,
): Promise<[xdr.SorobanAuthorizationEntry, xdr.SorobanAuthorizationEntry]> {
  const contextRuleIds = opts.contextRuleIds ?? [0];
  const nonceA = randomNonce();
  const sigPayloadA = signaturePayload(
    opts.rootInvocation,
    nonceA,
    opts.signatureExpirationLedger,
    opts.networkPassphrase,
  );

  const contextRuleIdsScVal = xdr.ScVal.scvVec(
    contextRuleIds.map((id) => xdr.ScVal.scvU32(id)),
  );
  const authDigest = hash(
    Buffer.concat([Buffer.from(sigPayloadA), Buffer.from(contextRuleIdsScVal.toXDR())]),
  );

  const entryA = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(opts.smartAccountId).toScAddress(),
        nonce: xdr.Int64.fromString(nonceA.toString()),
        signatureExpirationLedger: opts.signatureExpirationLedger,
        signature: smartAccountAuthPayloadScVal(opts.signerAddress, contextRuleIdsScVal),
      }),
    ),
    rootInvocation: opts.rootInvocation,
  });

  const nestedInvocation = buildInvocation({
    contractId: opts.smartAccountId,
    functionName: "__check_auth",
    args: [xdr.ScVal.scvBytes(authDigest)],
  });
  const entryB = await buildClassicAuthEntry(
    opts.signerAddress,
    nestedInvocation,
    opts.sign,
    opts.signatureExpirationLedger,
    opts.networkPassphrase,
  );

  return [entryA, entryB];
}

export interface BuildExecutorAuthOptions {
  intentRegistryId: string;
  intentId: Buffer;
  childSequence: number;
  executorAddress: string;
  sign: Keypair | SigningCallback;
  networkPassphrase: string;
  signatureExpirationLedger: number;
}

/**
 * Authorizes `intent_registry.mark_child_executed`, the *only* real
 * authorization check in `execute_scheduled_payment`'s whole call graph.
 *
 * `SourceAccount`/auto-fill credentials only cover a `require_auth()` at
 * the ROOT of the invocation tree; `mark_child_executed`'s
 * `executor.require_auth()` is two levels deep (`execute_scheduled_payment
 * -> intent_registry.mark_child_executed -> ensure_executor`), so it needs
 * an explicit entry, built and signed the same way as any other non-root
 * classic-account authorization -- this is *not* custom-account machinery
 * (the executor is a plain account), so no `AuthPayload`/Entry-A-Entry-B
 * pairing is involved, just one ordinary signed entry rooted directly at
 * `mark_child_executed`. Verified against live testnet (see the
 * smart-contracts repo's docs/TESTNET_FACTORY_DEPLOYMENT.md §8 and
 * docs/DAPP_INTEGRATION_SPEC.md §8), and independently against this same
 * failure mode in this dApp's own `src/lib/relayer/executor.ts`.
 */
export async function buildExecutorAuthEntry(
  opts: BuildExecutorAuthOptions,
): Promise<xdr.SorobanAuthorizationEntry> {
  const invocation = buildInvocation({
    contractId: opts.intentRegistryId,
    functionName: "mark_child_executed",
    args: [xdr.ScVal.scvBytes(opts.intentId), xdr.ScVal.scvU32(opts.childSequence)],
  });
  return buildClassicAuthEntry(
    opts.executorAddress,
    invocation,
    opts.sign,
    opts.signatureExpirationLedger,
    opts.networkPassphrase,
  );
}
