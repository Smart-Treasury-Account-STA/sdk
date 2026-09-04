import { describe, expect, it } from "vitest";
import { Address, xdr } from "@stellar/stellar-sdk";

import { findEvent, parseContractEvent, parseContractEvents } from "./events";

const ASSET = "CCOUVA654JH2V6B7LNTKHJP5DF3QA553RS2IIWXSGPDFH2N3QILIVU5L";
const DESTINATION = "GAK3XILRBYBMBOCZMSLL2CLR6WPQLEIOC6ZCYYPTE4OIAX3PCFFO2YMU";

function addressScVal(id: string) {
  return new Address(id).toScVal();
}

/** Builds a real `xdr.ContractEvent`, matching how `#[contractevent]`
 * actually encodes on-chain: topics[0] is the topic symbol, followed by
 * any further `#[topic]`-tagged fields, then a data map of the rest. */
function contractEvent(topicSymbol: string, topicFields: xdr.ScVal[], data: Record<string, xdr.ScVal>) {
  const dataMap = xdr.ScVal.scvMap(
    Object.entries(data)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
      ),
  );
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: null,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [xdr.ScVal.scvSymbol(topicSymbol), ...topicFields],
        data: dataMap,
      }),
    ),
  });
}

describe("parseContractEvent", () => {
  it("merges topic-tagged fields with the data map for a known event (TransferPaid)", () => {
    const event = contractEvent(
      "pay_ok",
      [addressScVal(ASSET), addressScVal(DESTINATION)],
      {
        amount: xdr.ScVal.scvI128(
          new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString("5000000") }),
        ),
        nonce: xdr.ScVal.scvU64(xdr.Uint64.fromString("42")),
      },
    );

    const parsed = parseContractEvent(event);

    expect(parsed.topic).toBe("pay_ok");
    expect(parsed.event).toMatchObject({
      asset: ASSET,
      destination: DESTINATION,
      amount: 5000000n,
      nonce: 42n,
    });
  });

  it("decodes an event with no topic-tagged fields beyond the symbol (Frozen)", () => {
    const event = contractEvent("frozen", [], {
      triggered_by_guardian: xdr.ScVal.scvBool(true),
    });

    const parsed = parseContractEvent(event);

    expect(parsed.topic).toBe("frozen");
    expect(parsed.event).toEqual({ triggered_by_guardian: true });
  });

  it("decodes an unknown topic as the untyped catch-all instead of throwing", () => {
    const event = contractEvent("mystery", [], { foo: xdr.ScVal.scvBool(false) });

    const parsed = parseContractEvent(event);

    expect(parsed.topic).toBe("mystery");
    expect(parsed.event).toEqual({ foo: false });
  });
});

describe("parseContractEvents / findEvent", () => {
  it("finds a specific event by topic among several", () => {
    const events = [
      contractEvent("frozen", [], { triggered_by_guardian: xdr.ScVal.scvBool(false) }),
      contractEvent(
        "pay_ok",
        [addressScVal(ASSET), addressScVal(DESTINATION)],
        {
          amount: xdr.ScVal.scvI128(
            new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString("1") }),
          ),
          nonce: xdr.ScVal.scvU64(xdr.Uint64.fromString("1")),
        },
      ),
    ];

    const parsed = parseContractEvents(events);
    const paid = findEvent(parsed, "pay_ok");

    expect(paid?.destination).toBe(DESTINATION);
  });

  it("returns undefined when the topic is not present", () => {
    const parsed = parseContractEvents([
      contractEvent("frozen", [], { triggered_by_guardian: xdr.ScVal.scvBool(false) }),
    ]);

    expect(findEvent(parsed, "pay_ok")).toBeUndefined();
  });

  it("returns an empty array for an empty event list", () => {
    expect(parseContractEvents([])).toEqual([]);
  });
});
