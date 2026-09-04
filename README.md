# sta-sdk

TypeScript SDK for the Smart Treasury Account (STA) Soroban contracts:
`smart_account` custom-authorization (Entry A / Entry B) construction,
transaction preparation (prepare → simulate → sign → submit → poll), typed
`#[contractevent]` parsing, and typed state reads (policy version, replay
nonce, recovery state).

## Install

```sh
npm install sta-sdk @stellar/stellar-sdk
```

`@stellar/stellar-sdk` (`>=16.0.0`) is a peer dependency — install it
yourself so your app controls the version and there is only ever one copy
of its classes (`Address`, `xdr.ScVal`, ...) loaded.

## Why this SDK hand-encodes calls instead of using generated bindings

The Stellar CLI's `stellar contract bindings typescript` output is pinned
to whatever `@stellar/stellar-sdk` major was current when it was
generated. Depending on those generated bindings directly here would force
every consumer of this SDK onto that exact major, and loading two majors
of the same runtime classes in one bundle risks `instanceof` mismatches.
So this package encodes `AuthPayload` structs, call args, and typed reads
by hand against the contracts' real `#[contracttype]`/`#[contractevent]`
definitions, verified live — see each module's doc comment for specifics.

## Usage

```ts
import { TESTNET, prepareTransferPayment, signAndSubmit, readPolicyVersion } from "sta-sdk";
import { Keypair } from "@stellar/stellar-sdk";

const signer = Keypair.fromSecret(process.env.SIGNER_SECRET!);
const expectedPolicyVersion = await readPolicyVersion(TESTNET, signer.publicKey());

const tx = await prepareTransferPayment(
  {
    net: TESTNET,
    feeSourceAddress: signer.publicKey(),
    signerAddress: signer.publicKey(),
    sign: signer,
  },
  {
    asset: "CASSET...",
    destination: "GDESTINATION...",
    amount: 100_0000000n,
    nonce: BigInt(Date.now()),
    expectedPolicyVersion,
  },
);

const result = await signAndSubmit(TESTNET, tx, signer);
console.log("ledger:", result.ledger);
```

See [`examples/`](./examples) for one runnable, documented example per
flow: transfer, split payment, scheduled payment, and event parsing.

## Modules

| Module | Exports |
|---|---|
| `config` | `NetworkConfig`, `TESTNET`, `buildMainnetConfig` |
| `auth` | `buildSmartAccountAuthEntries`, `buildExecutorAuthEntry`, auth-entry helpers |
| `payments` | `prepareTransferPayment`, `prepareSplitPayment`, `prepareScheduledPayment`, `prepareCancelScheduledPayment`, `signAndSubmit` |
| `events` | `parseContractEvent`, `parseContractEvents`, `findEvent` |
| `state` | typed reads: `AccountStatus`, `ContextRule`, `ScheduledIntent`, `RecoveryRequest`, `WasmHashes` |

## Versioning against a deployment

Each release states which contract deployment it targets. `TESTNET` in
`config.ts` is pinned to the currently-deployed testnet contract set (see
that module's doc comment for the source deployment record). Mainnet has
no deployment yet — `buildMainnetConfig` exists so wiring one in later is
a config call, not a code change; see its doc comment.

## Known issue — multi-signer context rules

`buildSmartAccountAuthEntries` builds Entry A + Entry B for a single
required signer. For a context rule with more than one required signer
(a real M-of-N threshold), calling it once per signer and attaching each
pair does **not** currently match the documented design (one shared
Entry A carrying all signers' keys, plus N Entry Bs collected against it).
Don't rely on multi-signer thresholds through this function until that's
fixed — see the doc comment on that function.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## Publishing

```sh
npm version <patch|minor|major>
npm publish
```

`prepublishOnly` runs typecheck, tests, and build first. CI
(`.github/workflows/publish.yml`) publishes automatically on a pushed
`v*` tag, using the `NPM_TOKEN` repository secret.
