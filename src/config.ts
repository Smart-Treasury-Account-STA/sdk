/**
 * Network configuration for `sta-sdk`.
 *
 * `testnet` is populated with the live, currently-deployed contract set --
 * the `smart_account` address is the account_factory-deployed treasury from
 * the smart-contracts repo's docs/TESTNET_FACTORY_DEPLOYMENT.md §13.2,
 * which runs the fixed contract code (see docs/SECURITY_REVIEW_STRICT.md
 * finding 29). The older hand-deployed treasury from docs/TESTNET_DEPLOYMENT.md
 * predates that fix and is not the default here.
 *
 * `MAINNET` stays `undefined` until `buildMainnetConfig` is actually called
 * with real, deployed contract addresses -- no mainnet deployment exists
 * yet, and nothing here fabricates one. What *is* ready now is the rest of
 * the mainnet shape: the real, verified mainnet network passphrase
 * (`MAINNET_NETWORK_PASSPHRASE`, a fixed protocol constant, unlike an RPC
 * URL) and `buildMainnetConfig` itself, so wiring in a real mainnet
 * deployment later is "call this function with the six addresses," not a
 * code change.
 */

export interface ContractAddresses {
  smartAccount: string;
  policyEngine: string;
  intentRegistry: string;
  recoveryManager: string;
  accountFactory: string;
  /** Never called directly by a client (see docs/DAPP_INTEGRATION_SPEC.md
   * §1) -- recorded for reference and for building auth-entry
   * sub-invocations by hand. */
  transferAdapter: string;
  splitAdapter: string;
}

export interface NetworkConfig {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  networkPassphrase: string;
  contracts: ContractAddresses;
}

export const TESTNET: NetworkConfig = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {
    smartAccount: "CD6GY4UUTNPW4TUV7LDL5SELN4BBHJG4KDDT3W6G23DY6XCGM75MULMQ",
    policyEngine: "CCOP7NRMST5K6TL7FBDMX25LDEPW3DSFBOGBIKVFIDNAAZY7GBMVP3M4",
    intentRegistry: "CAFIATSIZQSBILZJWVT4PVDXPVITJHLP6LPAVKDRHCA7I7XPZSLTRPUS",
    recoveryManager: "CCHC4YKVYS3CAZUOUYWYTEMQ6TZDW75WB2BGENUC2CDWDX5RH7NMKZWU",
    accountFactory: "CAQQTRRYNXIQGFVNCTMTBJDXW3PN7O44KPT7GWCCE4FRKTOHDBCWGUZO",
    transferAdapter: "CBRYGIR3ORDW5LE6J7AVPSKRNTMRUYHD6FVPHQMJGPQLQ5FQUZ2U6GFH",
    splitAdapter: "CBQA7UI7QN6RN4IZT7WPDHWTK2OO7J4FH2KMCVJGKMKVFGDURD63UQ7U",
  },
};

/**
 * Stellar's mainnet (Public Network) passphrase -- a fixed protocol
 * constant defined by the network itself (verified against
 * https://developers.stellar.org/docs/encyclopedia/network-passphrases),
 * not something that depends on which contracts (if any) are deployed.
 * Safe to hardcode, unlike a mainnet RPC URL (see `buildMainnetConfig`).
 */
export const MAINNET_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/**
 * Unlike testnet (SDF hosts `https://soroban-testnet.stellar.org` for
 * free), SDF does **not** operate a free public mainnet Soroban RPC
 * endpoint -- confirmed against
 * https://developers.stellar.org/docs/data/apis/rpc/providers, which
 * lists only third-party ecosystem providers (QuickNode, Ankr, Tatum,
 * Blockdaemon, etc.) for mainnet. There is no single correct default to
 * hardcode here, so `buildMainnetConfig` reads this env var instead of
 * assuming a provider on your behalf -- set it to whichever provider's
 * URL you've chosen, or pass `rpcUrl` to that function directly.
 */
export const MAINNET_RPC_URL_ENV = "STA_MAINNET_RPC_URL";

/**
 * Builds a mainnet `NetworkConfig` once the contracts are actually deployed
 * there. No mainnet deployment exists yet -- this function exists so this
 * module is ready to receive real mainnet addresses the moment a
 * deployment happens, not to fabricate one now.
 *
 * A `NetworkConfig` with `network: "mainnet"` and real signing keys
 * submits real, fee-paying, fund-moving transactions against Stellar's
 * production ledger -- don't build one just to "try it out" with testnet
 * addresses.
 *
 * @param contracts The six real contract addresses from an actual mainnet
 *   deployment record (mirroring how `TESTNET.contracts` above is sourced
 *   from the smart-contracts repo's docs/TESTNET_FACTORY_DEPLOYMENT.md).
 * @param rpcUrl Your chosen mainnet RPC provider's URL. Defaults to
 *   `process.env[MAINNET_RPC_URL_ENV]`; throws if neither is supplied,
 *   rather than silently falling back to some hardcoded provider.
 */
export function buildMainnetConfig(
  contracts: ContractAddresses,
  rpcUrl: string = (typeof process !== "undefined" ? process.env?.[MAINNET_RPC_URL_ENV] : undefined) ?? "",
): NetworkConfig {
  if (!rpcUrl) {
    throw new Error(
      `Mainnet RPC URL not configured -- pass one explicitly to buildMainnetConfig, or set ${MAINNET_RPC_URL_ENV}. SDF hosts no free public mainnet endpoint; see https://developers.stellar.org/docs/data/apis/rpc/providers for ecosystem providers.`,
    );
  }
  return {
    network: "mainnet",
    rpcUrl,
    networkPassphrase: MAINNET_NETWORK_PASSPHRASE,
    contracts,
  };
}

/** `undefined` until `buildMainnetConfig` is actually called with real,
 * deployed contract addresses -- see this module's doc comment and that
 * function's. No mainnet deployment exists yet. */
export const MAINNET: NetworkConfig | undefined = undefined;

export const NETWORKS = {
  testnet: TESTNET,
  mainnet: MAINNET,
} as const;
