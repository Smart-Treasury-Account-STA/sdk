/**
 * Typed event parsing. Depends only on `@stellar/stellar-sdk`'s
 * `xdr`/`scValToNative` -- no generated per-contract bindings involved.
 * Keep in sync by hand if the source contracts' `#[contractevent]`
 * definitions change — there is no automated link between this package
 * and the contracts repo.
 *
 * The Stellar CLI's generated bindings expose function signatures, errors,
 * and structs from a contract's spec, but not its `#[contractevent]`
 * definitions — those are hand-typed here, against the actual struct
 * definitions in each contract's `src/lib.rs`, and are exposed as
 * first-class types rather than raw event XDR.
 *
 * Every `#[contractevent]` struct is encoded on-chain as: topics[0] = the
 * event's short topic symbol (see the smart-contracts repo's
 * docs/DAPP_INTEGRATION_SPEC.md §10.4), followed by any further
 * `#[topic]`-tagged fields, then a data map of the remaining fields keyed
 * by their Rust field name.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";

export interface TransferPaid {
  asset: string;
  destination: string;
  amount: bigint;
  nonce: bigint;
}

export interface SplitPaid {
  asset: string;
  recipient_count: number;
  nonce: bigint;
}

export interface ScheduledPaymentExecuted {
  intent_id: Buffer;
  child_sequence: number;
  asset: string;
  destination: string;
  amount: bigint;
}

export interface PolicyValidated {
  operation: string;
  asset: string;
  destination: string;
  amount: bigint;
  expected_version: number;
}

export interface IntentCreated {
  intent_id: Buffer;
}

export interface IntentCancelled {
  intent_id: Buffer;
}

export interface ChildExecuted {
  intent_id: Buffer;
  child_sequence: number;
}

export interface RecoveryOpened {
  request_id: Buffer;
}

export interface RecoveryApproved {
  request_id: Buffer;
  guardian: string;
}

export interface RecoveryFinalized {
  request_id: Buffer;
  replacement_owner: string;
}

export interface RecoveryApplied {
  request_id: Buffer;
  replacement_owner: string;
}

export interface GuardianFreezeRequested {
  guardian: string;
}

export interface Frozen {
  triggered_by_guardian: boolean;
}

/** Every event type this module knows how to decode, keyed by its on-chain
 * topic symbol. Add new entries here as new contract events are curated. */
export interface EventMap {
  pay_ok: TransferPaid;
  splt_ok: SplitPaid;
  auto_ok: ScheduledPaymentExecuted;
  pol_ok: PolicyValidated;
  intent: IntentCreated;
  cancel: IntentCancelled;
  exec: ChildExecuted;
  open: RecoveryOpened;
  appr: RecoveryApproved;
  final: RecoveryFinalized;
  recover: RecoveryApplied;
  gfreeze: GuardianFreezeRequested;
  frozen: Frozen;
}

export type ParsedEvent =
  | { [K in keyof EventMap]: { topic: K; event: EventMap[K] } }[keyof EventMap]
  | { topic: string; event: Record<string, unknown> };

function topicSymbol(event: xdr.ContractEvent): string | undefined {
  const body = event.body().v0();
  const first = body.topics()[0];
  return first?.switch().name === "scvSymbol" ? first.sym().toString() : undefined;
}

/** `#[contractevent]`'s `#[topic]`-tagged fields, beyond the topic symbol
 * itself, in declaration order -- these live in `topics[1..]`, not the
 * data map, and (unlike the data map) carry no field names on-chain, so
 * this ordering must match each event struct's actual field order in its
 * `src/lib.rs`. Topic symbols are not globally unique across contracts
 * (e.g. `intent_registry`'s `IntentCancelled` and `recovery_manager`'s
 * `RecoveryCancelled` both use `"cancel"`) -- this map only covers the
 * events in `EventMap`; a topic outside it decodes as the untyped
 * catch-all below regardless of which contract emitted it. */
const TOPIC_FIELDS: Record<keyof EventMap, string[]> = {
  pay_ok: ["asset", "destination"],
  splt_ok: ["asset"],
  auto_ok: ["intent_id"],
  pol_ok: ["operation"],
  intent: ["intent_id"],
  cancel: ["intent_id"],
  exec: ["intent_id"],
  open: ["request_id"],
  appr: ["request_id", "guardian"],
  final: ["request_id"],
  recover: ["request_id"],
  gfreeze: ["guardian"],
  frozen: [],
};

function decodeFields(event: xdr.ContractEvent): Record<string, unknown> {
  const body = event.body().v0();
  const topics = body.topics();
  const topic = topicSymbol(event);
  const topicFieldNames = topic && topic in TOPIC_FIELDS ? TOPIC_FIELDS[topic as keyof EventMap] : [];

  const fromTopics: Record<string, unknown> = {};
  topicFieldNames.forEach((name, i) => {
    fromTopics[name] = scValToNative(topics[i + 1]);
  });

  const native = scValToNative(body.data());
  const fromData = native && typeof native === "object" ? (native as Record<string, unknown>) : {};

  return { ...fromTopics, ...fromData };
}

/** Parses one `xdr.ContractEvent` into its typed shape, matched by topic,
 * merging `#[topic]`-tagged fields (from `topics[1..]`) with the data map
 * -- both are needed to reconstruct the full `#[contractevent]` struct.
 * Unknown topics still parse -- as `{ topic, event: <raw decoded map> }`
 * -- rather than throwing, so a caller can log/inspect an event this
 * module doesn't have a named type for yet. */
export function parseContractEvent(event: xdr.ContractEvent): ParsedEvent {
  const topic = topicSymbol(event);
  const fields = decodeFields(event);
  return { topic: topic ?? "", event: fields } as ParsedEvent;
}

/** Parses every event from a `getTransaction` response's
 * `events.contractEventsXdr` (one array of events per operation -- this
 * dApp's transactions always have exactly one operation, so pass
 * `contractEventsXdr[0]`). */
export function parseContractEvents(events: xdr.ContractEvent[]): ParsedEvent[] {
  return events.map(parseContractEvent);
}

export function findEvent<T extends keyof EventMap>(
  events: ParsedEvent[],
  topic: T,
): EventMap[T] | undefined {
  const found = events.find((e) => e.topic === topic);
  return found?.event as EventMap[T] | undefined;
}
