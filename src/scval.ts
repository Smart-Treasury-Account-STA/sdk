import { xdr } from "@stellar/stellar-sdk";

/**
 * Builds the `ScMap` representation of a Soroban `#[contracttype]` struct.
 *
 * Keys are sorted, because the Soroban host requires it: an unsorted map is
 * rejected before the contract runs, with `Error(Object, InvalidInput)` and the
 * diagnostic "ScMap was not sorted by key for conversion to host object". The
 * Rust field declaration order is irrelevant to the wire format, so building
 * these maps in struct order — the intuitive thing to do — silently produces
 * calls that can never succeed.
 *
 * Plain string comparison is byte-order comparison here: Soroban symbols are
 * restricted to `[a-zA-Z0-9_]`, so UTF-16 code-unit order and UTF-8 byte order
 * agree.
 */
export function structScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, val]) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(key),
            val,
          }),
      ),
  );
}
