import { describe, expect, it } from "vitest";
import { Address, Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";

import {
  buildExecutorAuthEntry,
  buildInvocation,
  buildSmartAccountAuthEntries,
  signaturePayload,
} from "./auth";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const SMART_ACCOUNT = "CD6GY4UUTNPW4TUV7LDL5SELN4BBHJG4KDDT3W6G23DY6XCGM75MULMQ";
const INTENT_REGISTRY = "CAFIATSIZQSBILZJWVT4PVDXPVITJHLP6LPAVKDRHCA7I7XPZSLTRPUS";

describe("buildInvocation", () => {
  it("builds a contract-fn invocation with the given contract, function, and args", () => {
    const invocation = buildInvocation({
      contractId: SMART_ACCOUNT,
      functionName: "execute_transfer_payment",
      args: [],
    });

    const fn = invocation.function().contractFn();
    expect(fn.functionName().toString()).toBe("execute_transfer_payment");
    expect(Address.fromScAddress(fn.contractAddress()).toString()).toBe(SMART_ACCOUNT);
    expect(invocation.subInvocations()).toEqual([]);
  });

  it("carries declared sub-invocations", () => {
    const child = buildInvocation({ contractId: SMART_ACCOUNT, functionName: "transfer", args: [] });
    const parent = buildInvocation({
      contractId: SMART_ACCOUNT,
      functionName: "execute_transfer_payment",
      args: [],
      subInvocations: [child],
    });

    expect(parent.subInvocations()).toHaveLength(1);
  });
});

describe("signaturePayload", () => {
  it("is deterministic for identical inputs", () => {
    const invocation = buildInvocation({ contractId: SMART_ACCOUNT, functionName: "status", args: [] });
    const a = signaturePayload(invocation, 42n, 1000, NETWORK_PASSPHRASE);
    const b = signaturePayload(invocation, 42n, 1000, NETWORK_PASSPHRASE);

    expect(a.equals(b)).toBe(true);
  });

  it("changes when the nonce changes — the whole point of a nonce", () => {
    const invocation = buildInvocation({ contractId: SMART_ACCOUNT, functionName: "status", args: [] });
    const a = signaturePayload(invocation, 1n, 1000, NETWORK_PASSPHRASE);
    const b = signaturePayload(invocation, 2n, 1000, NETWORK_PASSPHRASE);

    expect(a.equals(b)).toBe(false);
  });

  it("changes across networks — a testnet-signed entry must not validate on mainnet", () => {
    const invocation = buildInvocation({ contractId: SMART_ACCOUNT, functionName: "status", args: [] });
    const testnet = signaturePayload(invocation, 1n, 1000, "Test SDF Network ; September 2015");
    const mainnet = signaturePayload(invocation, 1n, 1000, "Public Global Stellar Network ; September 2015");

    expect(testnet.equals(mainnet)).toBe(false);
  });
});

describe("buildSmartAccountAuthEntries", () => {
  it("builds Entry A (AuthPayload, address = smart_account) and Entry B (classic, address = signer)", async () => {
    const signer = Keypair.random();
    const rootInvocation = buildInvocation({
      contractId: SMART_ACCOUNT,
      functionName: "create_scheduled_payment",
      args: [],
    });

    const [entryA, entryB] = await buildSmartAccountAuthEntries({
      smartAccountId: SMART_ACCOUNT,
      rootInvocation,
      signerAddress: signer.publicKey(),
      sign: signer,
      networkPassphrase: NETWORK_PASSPHRASE,
      signatureExpirationLedger: 1_000_100,
    });

    const addressOf = (entry: xdr.SorobanAuthorizationEntry) =>
      Address.fromScAddress(entry.credentials().address().address()).toString();

    expect(addressOf(entryA)).toBe(SMART_ACCOUNT);
    expect(addressOf(entryB)).toBe(signer.publicKey());
    // Entry A's rootInvocation is the actual call being authorized.
    expect(entryA.rootInvocation()).toBe(rootInvocation);
    // Entry B's rootInvocation is the nested __check_auth call, not the
    // original call -- that's the whole "custom account" indirection.
    expect(entryB.rootInvocation().function().contractFn().functionName().toString()).toBe(
      "__check_auth",
    );
  });

  it("encodes Entry A's AuthPayload with the correct Signer::Delegated key and context_rule_ids", async () => {
    const signer = Keypair.random();
    const rootInvocation = buildInvocation({ contractId: SMART_ACCOUNT, functionName: "status", args: [] });

    const [entryA] = await buildSmartAccountAuthEntries({
      smartAccountId: SMART_ACCOUNT,
      rootInvocation,
      signerAddress: signer.publicKey(),
      sign: signer,
      networkPassphrase: NETWORK_PASSPHRASE,
      contextRuleIds: [2],
      signatureExpirationLedger: 1_000_100,
    });

    const payload = scValToNative(entryA.credentials().address().signature()) as {
      context_rule_ids: number[];
      signers: Record<string, Buffer>;
    };

    expect(payload.context_rule_ids).toEqual([2]);
    // scValToNative decodes a map with non-symbol keys (the Signer::Delegated
    // enum-variant vector, here) as a plain object with a stringified key --
    // not a Map -- confirmed directly against the installed SDK.
    const keys = Object.keys(payload.signers);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(`Delegated,${signer.publicKey()}`);
  });

  it("defaults to context rule 0 when none is supplied", async () => {
    const signer = Keypair.random();
    const rootInvocation = buildInvocation({ contractId: SMART_ACCOUNT, functionName: "status", args: [] });

    const [entryA] = await buildSmartAccountAuthEntries({
      smartAccountId: SMART_ACCOUNT,
      rootInvocation,
      signerAddress: signer.publicKey(),
      sign: signer,
      networkPassphrase: NETWORK_PASSPHRASE,
      signatureExpirationLedger: 1_000_100,
    });

    const payload = scValToNative(entryA.credentials().address().signature()) as {
      context_rule_ids: number[];
    };
    expect(payload.context_rule_ids).toEqual([0]);
  });
});

describe("buildExecutorAuthEntry", () => {
  it("builds one entry rooted directly at intent_registry.mark_child_executed, for the executor address", async () => {
    const executor = Keypair.random();
    const intentId = Buffer.alloc(32, 7);

    const entry = await buildExecutorAuthEntry({
      intentRegistryId: INTENT_REGISTRY,
      intentId,
      childSequence: 3,
      executorAddress: executor.publicKey(),
      sign: executor,
      networkPassphrase: NETWORK_PASSPHRASE,
      signatureExpirationLedger: 1_000_100,
    });

    expect(Address.fromScAddress(entry.credentials().address().address()).toString()).toBe(
      executor.publicKey(),
    );
    const fn = entry.rootInvocation().function().contractFn();
    expect(fn.functionName().toString()).toBe("mark_child_executed");
    expect(Address.fromScAddress(fn.contractAddress()).toString()).toBe(INTENT_REGISTRY);
    // No AuthPayload/custom-account machinery here -- authorizeEntry's
    // standard classic-signature encoding (a Vec of {public_key, signature}
    // structs, confirmed directly against the installed SDK), not a
    // contract-defined AuthPayload struct like Entry A's.
    const signature = scValToNative(entry.credentials().address().signature()) as Array<{
      public_key: Buffer;
    }>;
    expect(signature).toHaveLength(1);
    expect(Buffer.from(signature[0].public_key).equals(executor.rawPublicKey())).toBe(true);
  });

  it("is not the same entry (fresh nonce) across two calls with identical inputs", async () => {
    const executor = Keypair.random();
    const intentId = Buffer.alloc(32, 1);
    const opts = {
      intentRegistryId: INTENT_REGISTRY,
      intentId,
      childSequence: 1,
      executorAddress: executor.publicKey(),
      sign: executor,
      networkPassphrase: NETWORK_PASSPHRASE,
      signatureExpirationLedger: 1_000_100,
    };

    const first = await buildExecutorAuthEntry(opts);
    const second = await buildExecutorAuthEntry(opts);

    expect(first.credentials().address().nonce().toString()).not.toBe(
      second.credentials().address().nonce().toString(),
    );
  });
});
