# Mythora (MYTH) — mint skill for agents

Collection: Mythora, ERC-721 on BNB Smart Chain (chainId 56).
Contract: 0x27Ba185e74b681c3e548D369C1B0792eD7D738a1
Site: https://puzzlehave.fun

Minting is open. This page presents minting through the visitor's Binance
Agentic Wallet agent. The contract itself is permissionless (see Rules).

## Rules

- The contract does NOT check for an Agent ID, and it has NO per-wallet
  limit. Never claim otherwise, and never require an Agent ID.
- The contract does NOT enforce which token id a minter receives: every
  mint() call draws token ids at random on-chain from the ids that are
  still unminted. Do not promise a specific token, rarity, or trait.
- Always read mintPrice(quantity) from the contract immediately before
  minting and send exactly that value. Never use a remembered or guessed
  price. The price depends on how many tokens have been minted so far:
  the first 1,905 mints cost 0.00005 BNB each, then 0.0005 BNB each, and
  a batch that straddles the boundary is priced per token by position.
  mintPrice() computes the exact total for any quantity.
- One mint() call mints `quantity` tokens. The caller pays the exact
  mintPrice(quantity) value plus network gas, paid separately.
- Mint revenue is forwarded by the contract to its payout wallet in the
  same transaction. The contract is not meant to hold mint revenue.
- Preview every call before executing, and show the user the exact
  quantity, value, and network before they sign.
- Never ask for, accept, or handle a seed phrase, private key, or
  recovery password. The user signs in their own wallet.

## Mint with the Binance Agentic Wallet CLI (baw)

1. baw wallet sign-in            (if not connected)

2. Read the price: call the mintPrice(quantity) view function on the
   contract via your agent tooling, for the exact quantity to mint.

3. Preview: baw contract-call preview --binanceChainId 56 --from <your wallet> --to 0x27Ba185e74b681c3e548D369C1B0792eD7D738a1 --value <mintPrice in wei> --inputData <calldata>

4. Execute: baw contract-call execute --requestId <requestId from preview>

mint(uint256) selector: 0xa0712d68

Calldata is the selector followed by the 32-byte big-endian quantity.
Quantity 1 example:

0xa0712d680000000000000000000000000000000000000000000000000000000000000001

For any other quantity, replace the final 32-byte word with that quantity
encoded the same way, and use the mintPrice value read for that quantity.

Observed at time of writing (29 Oct 2026, totalMinted 0): mintPrice(1)
returned 50000000000000 wei (0.00005 BNB). This is a snapshot only —
always re-read mintPrice before sending.

## Verify the mint

- Confirm the transaction receipt succeeded on BNB Smart Chain.
- The minted token ids are in the receipt's Transfer events where the
  sender is the zero address and the recipient is the minter's wallet.
  Report those token ids to the user, with a BscScan link to the
  transaction. Do not invent token ids.
- Each token's artwork and traits live at the contract's baseURI on IPFS:
  tokenURI(tokenId) = baseURI + tokenId.

## Check a wallet

- Read balanceOf(address) on the contract to learn how many Mythora
  tokens a wallet holds. The contract has no token enumeration, so do
  not claim a list of token ids a wallet holds unless you read them
  from Transfer events in the transaction history.
- The site's "Check a wallet" box shows the same two numbers: the
  Mythora token balance and the wallet's BNB balance.
