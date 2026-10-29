/* Mythora reconstruction — client-side hash routing, real on-chain minting.
 * The Mint box connects the visitor's own wallet and sends real mint()
 * transactions to the deployed Mythora contract on BNB Smart Chain.
 * Counters and prices are read live from the contract via public RPC.
 * No seed phrase or private key is ever asked for or handled here. */
(function () {
  "use strict";

  var DATA = window.MYTHORA_DATA;
  var tokensById = {};
  DATA.tokens.forEach(function (t) { tokensById[t.id] = t; });

  /* Deployed contract (verified on-chain 29 Oct 2026; minting open). */
  var CONTRACT_ADDRESS = "0x27Ba185e74b681c3e548D369C1B0792eD7D738a1";
  var CHAIN_ID = 56;
  var RPC_URLS = [
    "https://bsc.publicnode.com",
    "https://bsc-dataseed1.binance.org",
    "https://bsc-dataseed1.defibit.io"
  ];
  var MINT_ABI = [
    "function totalMinted() view returns (uint256)",
    "function remainingSupply() view returns (uint256)",
    "function mintActive() view returns (bool)",
    "function mintPrice(uint256 quantity) view returns (uint256)",
    "function MAX_SUPPLY() view returns (uint256)",
    "function mint(uint256 quantity) payable",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
  ];
  var MAX_QTY = 20; // UI-only cap per transaction; the contract has no cap.
  var ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  var state = {
    wallet: null, // { address, truncated }
    wrongChain: false,
    noProvider: false,
    sessionMintedIds: [],
    lastMintedIds: [],
    lastTxHash: null,
    mintPending: false,
    mintMessage: null, // { kind: "info"|"ok"|"error", text, txHash }
    priceWei: null, // decimal string for the current quantity, null = unknown
    priceLoading: false,
    priceError: false,
    votes: { "celestial-kitsune": 0, "raijin-dragon": 0, "moonlit-yuki-onna": 0 },
    currentVote: null,
    mintQty: 1,
    gallery: { rarity: "all", status: "all", search: "", visible: 24 }
  };

  /* Live chain state, read via public RPC. No wallet needed for reading. */
  var chainState = {
    loaded: false,
    loading: false,
    error: false,
    loadedAt: 0,
    totalMinted: null,
    remaining: null,
    cap: 3810,
    active: null
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* Final artwork, served from the pinned IPFS tree (Filebase gateway).
   * Every token shows its own file: images-final/<id>.jpg, Legends
   * <id>.webp. Written traits match the artwork by construction: the
   * trait fields in data.js come from the same metadata the artwork
   * was rendered from. Root CID:
   * bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u */
  var IPFS_GATEWAY = "https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/";
  function artFor(token, large) {
    var ext = token.rarity === "Legendary" ? "webp" : "jpg";
    var src = IPFS_GATEWAY + "images-final/" + token.id + "." + ext;
    var label = esc(token.name) + ", " + (token.rarity === "Legendary" ? "Legendary artwork" : esc(token.rarity) + " — final artwork");
    return '<img class="art art-img' + (large ? " art-lg" : "") + '" src="' + src + '" alt="' + label + '" loading="lazy">';
  }

  function truncated(address) { return address.slice(0, 6) + "…" + address.slice(-4); }

  /* Format a wei amount (decimal string) as BNB, e.g. "0.00005". */
  function fmtWei(weiStr) {
    var w = BigInt(weiStr);
    var whole = w / 1000000000000000000n;
    var frac = w % 1000000000000000000n;
    if (frac === 0n) return whole.toString();
    var f = frac.toString().padStart(18, "0").replace(/0+$/, "");
    return whole.toString() + "." + f;
  }

  function announce(msg) {
    var live = $("#live-region");
    if (live) live.textContent = msg;
  }

  /* ---------------- Live chain reads (public RPC, no wallet) ---------------- */

  var readContract = null;
  var readContractPromise = null;

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error("RPC timeout")); }, ms);
      })
    ]);
  }

  function getReadContract() {
    if (readContract) return Promise.resolve(readContract);
    if (readContractPromise) return readContractPromise;
    if (typeof ethers === "undefined") {
      return Promise.reject(new Error("Wallet library did not load."));
    }
    readContractPromise = (function tryNext(i) {
      if (i >= RPC_URLS.length) throw new Error("No public RPC answered.");
      var provider = new ethers.JsonRpcProvider(RPC_URLS[i]);
      return withTimeout(provider.getBlockNumber(), 10000).then(function () {
        readContract = new ethers.Contract(CONTRACT_ADDRESS, MINT_ABI, provider);
        return readContract;
      }).catch(function () { return tryNext(i + 1); });
    })(0).catch(function (e) {
      readContractPromise = null;
      throw e;
    });
    return readContractPromise;
  }

  function loadChainState(force) {
    if (chainState.loading) return Promise.resolve();
    if (chainState.loaded && !force) return Promise.resolve();
    chainState.loading = true;
    return getReadContract().then(function (c) {
      return Promise.all([c.totalMinted(), c.remainingSupply(), c.MAX_SUPPLY(), c.mintActive()]);
    }).then(function (res) {
      chainState.totalMinted = Number(res[0]);
      chainState.remaining = Number(res[1]);
      chainState.cap = Number(res[2]);
      chainState.active = !!res[3];
      chainState.loaded = true;
      chainState.error = false;
      chainState.loadedAt = Date.now();
    }).catch(function () {
      chainState.error = true;
      chainState.loaded = false;
    }).then(function () {
      chainState.loading = false;
      syncChainUi();
    });
  }

  /* Update every chain-dependent number already on the page, in place,
   * so a late RPC answer never jumps the user's scroll position. */
  function syncChainUi() {
    var mintedText = chainState.error ? "—" : (chainState.totalMinted == null ? "…" : String(chainState.totalMinted));
    var remainingText = chainState.error ? "—" : (chainState.remaining == null ? "…" : String(chainState.remaining));
    $all('[data-counter="minted"]').forEach(function (el) { el.textContent = mintedText; });
    $all('[data-counter="remaining"]').forEach(function (el) { el.textContent = remainingText; });
    $all('[data-live="totalMinted"]').forEach(function (el) { el.textContent = mintedText; });
    $all('[data-live="mintActive"]').forEach(function (el) {
      el.textContent = chainState.error ? "—" : (chainState.active == null ? "…" : (chainState.active ? "On (mintActive is true)" : "Off (mintActive is false)"));
    });
    var retry = $("#chain-retry");
    if (retry) retry.style.display = chainState.error ? "" : "none";
    var totalsNote = $("#mint-totals-note");
    if (totalsNote) totalsNote.style.display = chainState.error ? "" : "none";
    updateMintButton();
  }

  /* ---------------- Wallet (visitor's own wallet, injected provider) ---------------- */

  function getWalletProvider() {
    if (typeof window.ethereum !== "undefined") return window.ethereum;
    if (typeof window.binancew3w !== "undefined" && window.binancew3w.ethereum) return window.binancew3w.ethereum;
    return null;
  }

  function attachWalletListeners(wp) {
    if (!wp || !wp.on || wp.__mythoraListeners) return;
    wp.__mythoraListeners = true;
    wp.on("accountsChanged", function (accounts) {
      if (!accounts || !accounts.length) {
        disconnectWallet();
      } else {
        state.wallet = { address: accounts[0], truncated: truncated(accounts[0]) };
        render();
        refreshPrice();
      }
    });
    wp.on("chainChanged", function () {
      refreshWalletChain().then(function () { render(); refreshPrice(); });
    });
  }

  function refreshWalletChain() {
    var wp = getWalletProvider();
    if (!wp || !state.wallet) { state.wrongChain = false; return Promise.resolve(); }
    return wp.request({ method: "eth_chainId" }).then(function (chainIdHex) {
      state.wrongChain = parseInt(chainIdHex, 16) !== CHAIN_ID;
    }).catch(function () { state.wrongChain = false; });
  }

  function switchToBsc() {
    var wp = getWalletProvider();
    if (!wp) return Promise.resolve();
    return wp.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x38" }]
    }).catch(function (e) {
      if (e && e.code === 4902) {
        return wp.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x38",
            chainName: "BNB Smart Chain",
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            rpcUrls: ["https://bsc-dataseed.binance.org/"],
            blockExplorerUrls: ["https://bscscan.com"]
          }]
        });
      }
      throw e;
    }).then(function () {
      state.wrongChain = false;
      render();
      refreshPrice();
    }).catch(function (e) {
      if (e && e.code === 4001) {
        announce("Network switch cancelled in the wallet.");
      } else {
        announce("Could not switch networks. Switch to BNB Smart Chain in your wallet and try again.");
      }
    });
  }

  function connectWallet() {
    var wp = getWalletProvider();
    if (!wp) {
      state.noProvider = true;
      render();
      announce("No wallet detected in this browser. Open this site in your wallet app's browser to mint.");
      return;
    }
    state.noProvider = false;
    announce("Waiting for approval in your wallet…");
    wp.request({ method: "eth_requestAccounts" }).then(function (accounts) {
      if (!accounts || !accounts.length) throw new Error("No account returned.");
      state.wallet = { address: accounts[0], truncated: truncated(accounts[0]) };
      attachWalletListeners(wp);
      return refreshWalletChain();
    }).then(function () {
      render();
      refreshPrice();
      announce("Wallet connected: " + state.wallet.truncated);
    }).catch(function (e) {
      if (e && e.code === 4001) {
        announce("Connection cancelled in the wallet. Nothing was connected.");
      } else {
        announce("Could not connect the wallet. Open this site in your wallet app's browser and try again.");
      }
      render();
    });
  }

  function disconnectWallet() {
    state.wallet = null;
    state.wrongChain = false;
    state.lastMintedIds = [];
    state.lastTxHash = null;
    state.mintMessage = null;
    render();
    announce("Wallet disconnected.");
  }

  /* ---------------- Counters ---------------- */

  function counters() {
    return {
      minted: chainState.totalMinted,
      remaining: chainState.remaining,
      cap: chainState.cap,
      error: chainState.error,
      loaded: chainState.loaded
    };
  }

  function displayNum(v, error) {
    if (error) return "—";
    return v == null ? "…" : String(v);
  }

  function countersHtml() {
    var c = counters();
    return '<div class="counters" aria-label="Collection counters">' +
      '<div class="counter"><strong data-counter="minted">' + displayNum(c.minted, c.error) + '</strong><span>MINTED</span></div>' +
      '<div class="counter"><strong data-counter="remaining">' + displayNum(c.remaining, c.error) + '</strong><span>REMAINING</span></div>' +
      '<div class="counter"><strong>' + c.cap + '</strong><span>COLLECTION CAP</span></div>' +
      "</div>";
  }

  function rarityPill(rarity) {
    return '<span class="pill pill-' + rarity.toLowerCase() + '">' + esc(rarity.toUpperCase()) + "</span>";
  }

  function tokenCard(token) {
    return '<article class="token-card">' +
      '<a href="#/nft/' + token.id + '" aria-label="View Mythora #' + token.id + ", " + esc(token.name) + '">' +
      artFor(token) +
      '<div class="token-body">' +
      "<p class=\"token-meta\">Mythora #" + token.id + (token.edition ? " &middot; Edition " + esc(token.edition) : "") + "</p>" +
      '<h3 class="token-name">' + esc(token.name) + "</h3>" +
      "<p>" + rarityPill(token.rarity) + " " +
      (token.status === "Minted" ? '<span class="pill pill-minted">MINTED</span>' : token.status === "Burned" ? '<span class="pill pill-burned">BURNED</span>' : '<span class="pill">AVAILABLE</span>') + "</p>" +
      "<p class=\"token-meta\">" + esc(token.element) + " &middot; " + esc(token.aura) + "</p>" +
      "</div></a></article>";
  }

  function parseHash() {
    var raw = window.location.hash || "#/";
    var hash = raw.replace(/^#/, "");
    var parts = hash.split("?");
    var path = parts[0] || "/";
    var query = {};
    if (parts[1]) {
      parts[1].split("&").forEach(function (pair) {
        var kv = pair.split("=");
        query[decodeURIComponent(kv[0] || "")] = decodeURIComponent(kv[1] || "");
      });
    }
    return { path: path, query: query };
  }

  function setNav(path) {
    $all(".main-nav a").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var route = href.replace(/^#/, "");
      var current = (path === "/" && route === "/") ||
        (path !== "/" && route !== "/" && path.indexOf(route) === 0);
      if (current) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  function renderHeaderWallet() {
    var box = $("#wallet-box");
    if (!box) return;
    if (state.wallet) {
      box.innerHTML =
        '<span aria-label="Connected wallet address, truncated">' + esc(state.wallet.truncated) + "</span>" +
        '<button type="button" class="btn-ghost" id="disconnect-btn">Disconnect</button>';
      $("#disconnect-btn").addEventListener("click", disconnectWallet);
    } else {
      box.innerHTML = '<button type="button" class="btn-primary" id="connect-btn">Connect Wallet</button>';
      $("#connect-btn").addEventListener("click", connectWallet);
    }
  }

  /* ---------------- Home ---------------- */
  function homeView() {
    var legends = DATA.tokens.filter(function (t) { return t.rarity === "Legendary"; });
    var featured = tokensById[158];
    var oni = tokensById[672];
    var tengu = tokensById[686];
    var marquee = legends.map(function (t) { return '<span class="cover-cell">' + artFor(t) + "</span>"; }).join("");
    var rows = DATA.rarity.map(function (r) {
      return "<tr><td>" + esc(r.name) + "</td><td>" + r.share + "</td><td>" + r.count + "</td><td>" + esc(r.weight) + "</td></tr>";
    }).join("");
    return '<div class="banner" role="note"><strong>CONTRACT DEPLOYED &bull; VERIFIED ON-CHAIN</strong>' +
      "<p>The Mythora contract is deployed on BNB Smart Chain: <a href=\"https://bscscan.com/address/0x27Ba185e74b681c3e548D369C1B0792eD7D738a1\" target=\"_blank\" rel=\"noopener noreferrer\">0x27Ba185e74b681c3e548D369C1B0792eD7D738a1</a>. Minting is open on-chain. Connect your wallet to mint &mdash; every mint is a real on-chain transaction.</p></div>" +
      '<section class="cover" aria-label="Mythora cover">' +
      '<div class="cover-stars" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>' +
      '<p class="eyebrow">PERMANENT 3,810 CAP &bull; BNB SMART CHAIN</p>' +
      '<h1 class="cover-title">AWAKEN YOUR CHIBI YOKAI</h1>' +
      '<p class="lede">A collector-first drop of 3,810 mythic chibi guardians on BNB Smart Chain. You get your card right away, and every rarity rule published in the open.</p>' +
      '<div class="hero-actions"><a class="button btn-primary" href="#/mint">Enter the Mint</a>' +
      '<a class="button btn-ghost" href="#/transparency">Read the Rules</a></div>' +
      '<div class="cover-float">' +
      '<figure class="float-card float-side float-left"><a href="#/nft/672">' + artFor(oni) + '</a><figcaption>Oni, the Royal Warden</figcaption></figure>' +
      '<figure class="float-card float-center"><a href="#/nft/158">' + artFor(featured) + '</a><figcaption>Featured Legend &middot; Edition ' + esc(featured.edition) + "<br>" + esc(featured.name) + "</figcaption></figure>" +
      '<figure class="float-card float-side float-right"><a href="#/nft/686">' + artFor(tengu) + "</a><figcaption>Tengu, the Gale Herald</figcaption></figure>" +
      "</div>" +
      '<div class="cover-marquee" aria-hidden="true"><div class="cover-track">' + marquee + marquee + "</div></div></section>" +
      countersHtml() +
      '<section aria-labelledby="legends-h"><h2 id="legends-h">The Twelve Legends</h2>' +
      '<p>Twelve 1-of-1 Mythic Yokai, each with a hand-crafted design, an animated celestial aura, its own role and a custom edition number.</p>' +
      '<div class="legend-grid">' + legends.map(tokenCard).join("") + "</div>" +
      '<p><a href="#/gallery?rarity=legendary">Meet all twelve &rarr;</a></p></section>' +
      '<section aria-labelledby="rarity-h"><h2 id="rarity-h">Rarity, published in full</h2>' +
      "<p>The allocation was committed at genesis and can never change &mdash; every tier and every count, published. In this reconstruction, the gallery allocation outside the 12 Legends is generated deterministically and is not the original genesis table; see the gallery notice.</p>" +
      '<div class="card"><table><thead><tr><th>Tier</th><th>Share</th><th>Count</th><th>Voting weight</th></tr></thead><tbody>' + rows + "</tbody></table></div></section>" +
      '<section aria-labelledby="utility-h"><h2 id="utility-h">Real utility, from day one</h2><div class="grid-3">' +
      '<div class="card"><h3>Holder community</h3><p>Planned: owning a Mythora is described as unlocking the holder community. No gated channels or holder-only links are provided in this reconstruction.</p></div>' +
      '<div class="card"><h3>Vote the next design</h3><p>Holders decide which chibi the forges craft next. One weighted vote per wallet, switchable any time.</p><p><a href="#/governance">Open voting</a></p></div>' +
      '<div class="card"><h3>Mythora on X</h3><p>Daily lore, drop alerts and holder-only events on the official profile.</p><p><a href="' + DATA.xUrl + '" target="_blank" rel="noopener noreferrer">Follow @MythoraNFT on X</a></p></div>' +
      "</div></section>" +
      '<section class="card" style="text-align:center"><h2>3,810. Forever. Nothing more.</h2>' +
      "<p>The cap is written into the contract and cannot be raised &mdash; scarcity you can verify, not a promise.</p>" +
      '<p><a class="button btn-primary" href="#/mint">Mint yours</a></p></section>';
  }

  /* ---------------- Mint (real, on-chain) ---------------- */

  /* No reveal step: the minter gets the actual card right away, directly
   * on this page. No question-mark card, no waiting, no dialog. The
   * token ids come from the Transfer events in the mint receipt. */
  function mintedCardsHtml() {
    if (!state.lastMintedIds.length) return "";
    var cards = state.lastMintedIds.map(function (id) { return tokenCard(tokensById[id]); }).join("");
    var txLine = state.lastTxHash
      ? '<p>Transaction: <a href="https://bscscan.com/tx/' + esc(state.lastTxHash) + '" target="_blank" rel="noopener noreferrer">' + esc(state.lastTxHash) + "</a></p>"
      : "";
    return '<section class="card" id="your-cards" aria-labelledby="your-cards-h"><h3 id="your-cards-h">Your card' + (state.lastMintedIds.length > 1 ? "s" : "") + "</h3>" +
      "<p>You got your card right away &mdash; no question-mark card, no waiting. These are real tokens, minted on-chain to your wallet.</p>" +
      txLine +
      '<div class="grid-3">' + cards + "</div></section>";
  }

  function mintMessageHtml() {
    if (!state.mintMessage) return "";
    var m = state.mintMessage;
    var cls = m.kind === "error" ? "mint-status mint-status-error" : (m.kind === "ok" ? "mint-status mint-status-ok" : "mint-status");
    var tx = m.txHash
      ? ' <a href="https://bscscan.com/tx/' + esc(m.txHash) + '" target="_blank" rel="noopener noreferrer">View on BscScan</a>'
      : "";
    return '<p class="' + cls + '" id="mint-status" role="status">' + esc(m.text) + tx + "</p>";
  }

  function mintButtonState() {
    if (state.mintPending) return { disabled: true, label: "Waiting for confirmation…" };
    if (chainState.remaining === 0) return { disabled: true, label: "Sold out" };
    if (chainState.loaded && chainState.active === false) return { disabled: true, label: "Minting is off" };
    if (state.wrongChain) return { disabled: true, label: "Switch to BNB Smart Chain" };
    if (!state.wallet) return { disabled: true, label: "Mint" };
    if (state.priceLoading || state.priceError || state.priceWei == null) return { disabled: true, label: "Mint" };
    if (chainState.remaining != null && state.mintQty > chainState.remaining) return { disabled: true, label: "Mint" };
    if (!chainState.loaded && !chainState.error) return { disabled: true, label: "Mint" };
    if (chainState.error) return { disabled: true, label: "Mint" };
    return { disabled: false, label: "Mint" };
  }

  function updateMintButton() {
    var btn = $("#mint-btn");
    if (!btn) return;
    var s = mintButtonState();
    btn.disabled = s.disabled;
    btn.textContent = s.label;
    var minus = $("#qty-minus"), plus = $("#qty-plus");
    var maxQty = MAX_QTY;
    if (chainState.remaining != null) maxQty = Math.min(MAX_QTY, Math.max(1, chainState.remaining));
    if (minus) minus.disabled = state.mintQty <= 1;
    if (plus) plus.disabled = state.mintQty >= maxQty;
  }

  function updatePriceLine() {
    var el = $("#price-line");
    if (!el) return;
    if (state.priceLoading) {
      el.textContent = "Total: calculating…";
    } else if (state.priceError) {
      el.textContent = "Total: price unavailable. Check your connection and try again.";
    } else if (state.priceWei != null) {
      el.innerHTML = "Total: <strong>" + esc(fmtWei(state.priceWei)) + " BNB</strong> for " + state.mintQty + " token" + (state.mintQty === 1 ? "" : "s") + " (plus network gas, paid separately).";
    } else {
      el.textContent = "Total: …";
    }
  }

  var priceSeq = 0;
  function refreshPrice() {
    var qty = state.mintQty;
    var seq = ++priceSeq;
    state.priceLoading = true;
    state.priceError = false;
    updatePriceLine();
    updateMintButton();
    getReadContract().then(function (c) {
      return c.mintPrice(qty);
    }).then(function (price) {
      if (seq !== priceSeq) return;
      state.priceWei = price.toString();
      state.priceLoading = false;
      updatePriceLine();
      updateMintButton();
    }).catch(function () {
      if (seq !== priceSeq) return;
      state.priceWei = null;
      state.priceLoading = false;
      state.priceError = true;
      updatePriceLine();
      updateMintButton();
    });
  }

  function setMintMessage(kind, text, txHash) {
    state.mintMessage = { kind: kind, text: text, txHash: txHash || null };
    var slot = $("#mint-status-slot");
    if (slot) slot.innerHTML = mintMessageHtml();
    announce(text);
  }

  function mintView() {
    var c = counters();
    if (state.mintQty > MAX_QTY) state.mintQty = MAX_QTY;
    if (c.remaining != null && state.mintQty > Math.max(1, c.remaining)) state.mintQty = Math.max(1, Math.min(MAX_QTY, c.remaining));
    var totalsLine = '<p class="mint-totals" aria-label="Total item, sudah mint, dan sisa"><strong>Total Item:</strong> ' + c.cap + ' &nbsp;&middot;&nbsp; <strong>Sudah Mint:</strong> <span data-counter="minted">' + displayNum(c.minted, c.error) + '</span> &nbsp;&middot;&nbsp; <strong>Sisa:</strong> <span data-counter="remaining">' + displayNum(c.remaining, c.error) + "</span></p>" +
      '<p class="notice" id="mint-totals-note" style="display:' + (c.error ? "" : "none") + '">The on-chain count could not be read. Check your connection. <button type="button" class="btn-ghost" id="chain-retry">Retry</button></p>';
    var walletBlock;
    if (state.wallet) {
      walletBlock = '<p>Connected wallet: <span class="mint-address">' + esc(state.wallet.address) + "</span></p>" +
        (state.wrongChain
          ? '<p class="mint-status mint-status-error">Your wallet is not on BNB Smart Chain.</p><p><button type="button" class="btn-primary" id="switch-chain-btn">Switch to BNB Smart Chain</button></p>'
          : "");
    } else {
      walletBlock = '<p>Connect your wallet to mint. Your wallet signs the transaction; this page never asks for a seed phrase or private key.</p>' +
        '<p><button type="button" class="btn-primary" id="mint-connect-btn">Connect Wallet</button></p>';
    }
    var oddsRows = DATA.rarity.map(function (r) {
      return "<tr><td>" + esc(r.name) + "</td><td>" + r.count + "</td><td>" + r.share + "</td></tr>";
    }).join("");
    var s = mintButtonState();
    var mintPanel = '<div id="panel-mint">' +
      "<h3>Mint</h3>" +
      '<div class="qty-row"><label for="mint-qty-label">Quantity</label>' +
      '<button type="button" id="qty-minus" aria-label="Decrease quantity">&minus;</button>' +
      '<output id="mint-qty-label" aria-live="polite">' + state.mintQty + "</output>" +
      '<button type="button" id="qty-plus" aria-label="Increase quantity">+</button>' +
      '<span class="token-meta">Max ' + MAX_QTY + " per transaction</span>" +
      "</div>" +
      '<p class="price-line" id="price-line">Total: …</p>' +
      '<button type="button" class="btn-primary" id="mint-btn" ' + (s.disabled ? "disabled" : "") + ">" + esc(s.label) + "</button>" +
      "</div>";
    return '<section aria-labelledby="mint-h"><h2 id="mint-h">Mint Portal</h2>' +
      walletBlock + totalsLine + '<div id="mint-status-slot">' + mintMessageHtml() + "</div>" + mintedCardsHtml() +
      '<div class="card" id="mint-box">' + mintPanel + "</div>" +
      '<div class="card odds"><h3>Your odds on every mint</h3>' +
      "<p>Odds below are the collection counts. Every mint draws a random remaining token id on-chain, and every remaining card &mdash; Legendary included &mdash; can be drawn.</p>" +
      "<table><thead><tr><th>Tier</th><th>Count</th><th>Share</th></tr></thead><tbody>" + oddsRows + "</tbody></table></div>" +
      '<p><a href="#/gallery">Browse the codex</a> &middot; <a href="#/transparency">Read the mint rules</a></p></section>';
  }

  function bindMint() {
    var minus = $("#qty-minus");
    var plus = $("#qty-plus");
    if (minus) minus.addEventListener("click", function () {
      if (state.mintQty > 1) { state.mintQty--; render(); refreshPrice(); }
    });
    if (plus) plus.addEventListener("click", function () {
      var maxQty = MAX_QTY;
      if (chainState.remaining != null) maxQty = Math.min(MAX_QTY, Math.max(1, chainState.remaining));
      if (state.mintQty < maxQty) { state.mintQty++; render(); refreshPrice(); }
    });
    var connectBtn = $("#mint-connect-btn");
    if (connectBtn) connectBtn.addEventListener("click", connectWallet);
    var switchBtn = $("#switch-chain-btn");
    if (switchBtn) switchBtn.addEventListener("click", switchToBsc);
    var retry = $("#chain-retry");
    if (retry) retry.addEventListener("click", function () { loadChainState(true); refreshPrice(); });
    var mintBtn = $("#mint-btn");
    if (mintBtn) mintBtn.addEventListener("click", function () { doRealMint(state.mintQty); });
    updateMintButton();
    refreshPrice();
  }

  function mintErrorMessage(e) {
    if (e && e.code === 4001) return "Cancelled in your wallet. No transaction was sent and nothing was charged.";
    if (e && e.message === "WRONG_CHAIN") return "Your wallet is not on BNB Smart Chain. Switch networks and try again.";
    if (e && e.message === "MINT_OFF") return "Minting is currently off.";
    if (e && e.message === "SOLD_OUT") return "Not enough tokens left for that quantity.";
    var msg = (e && e.message) ? String(e.message) : String(e);
    if (/insufficient funds/i.test(msg)) return "Your wallet does not have enough BNB for this mint plus network gas.";
    if (/incorrect payment/i.test(msg)) return "The contract rejected the payment amount. The price may have changed; try again.";
    if (/exceeds max supply/i.test(msg)) return "That quantity exceeds the remaining supply.";
    if (/minting is not active/i.test(msg)) return "Minting is currently off.";
    return "Mint failed: " + msg.slice(0, 160);
  }

  function parseMintedIds(receipt, minterAddress, iface) {
    var ids = [];
    for (var i = 0; i < receipt.logs.length; i++) {
      try {
        var parsed = iface.parseLog(receipt.logs[i]);
        if (parsed && parsed.name === "Transfer" &&
            parsed.args.from.toLowerCase() === ZERO_ADDRESS &&
            parsed.args.to.toLowerCase() === minterAddress.toLowerCase()) {
          ids.push(Number(parsed.args.tokenId));
        }
      } catch (e) { /* log from another contract or event; ignore */ }
    }
    return ids;
  }

  function doRealMint(qty) {
    if (state.mintPending) return;
    if (!state.wallet) {
      setMintMessage("error", "Connect your wallet first.");
      return;
    }
    if (typeof ethers === "undefined") {
      setMintMessage("error", "The wallet library did not load. Reload the page and try again.");
      return;
    }
    var wp = getWalletProvider();
    if (!wp) {
      setMintMessage("error", "No wallet detected in this browser. Open this site in your wallet app's browser to mint.");
      return;
    }
    state.mintPending = true;
    updateMintButton();
    setMintMessage("info", "Checking the contract…");
    var provider = new ethers.BrowserProvider(wp);
    var signer;
    var writeContract;
    provider.getSigner().then(function (s) {
      signer = s;
      return signer.getAddress();
    }).then(function (minterAddress) {
      return provider.getNetwork().then(function (net) {
        if (Number(net.chainId) !== CHAIN_ID) throw new Error("WRONG_CHAIN");
        writeContract = new ethers.Contract(CONTRACT_ADDRESS, MINT_ABI, signer);
        return Promise.all([
          writeContract.mintActive(),
          writeContract.remainingSupply(),
          writeContract.mintPrice(qty),
          minterAddress
        ]);
      });
    }).then(function (res) {
      var active = res[0], remaining = res[1], price = res[2], minterAddress = res[3];
      if (!active) throw new Error("MINT_OFF");
      if (remaining < BigInt(qty)) throw new Error("SOLD_OUT");
      return writeContract.mint.estimateGas(qty, { value: price }).then(function (est) {
        var gasLimit = est * 120n / 100n; // 20% safety margin
        setMintMessage("info", "Waiting for approval in your wallet… Check the quantity, price and network in your wallet before approving.");
        return writeContract.mint(qty, { value: price, gasLimit: gasLimit });
      }).then(function (tx) {
        state.lastTxHash = tx.hash;
        setMintMessage("info", "Transaction sent. Waiting for network confirmation…", tx.hash);
        return tx.wait().then(function (receipt) {
          return { receipt: receipt, minterAddress: minterAddress };
        });
      });
    }).then(function (out) {
      var iface = new ethers.Interface(MINT_ABI);
      var ids = parseMintedIds(out.receipt, out.minterAddress, iface);
      state.lastMintedIds = ids;
      ids.forEach(function (id) { state.sessionMintedIds.push(id); });
      if (ids.length) {
        setMintMessage("ok", "Minted " + ids.length + " token" + (ids.length === 1 ? "" : "s") + ". Your card" + (ids.length === 1 ? " is" : "s are") + " below.", state.lastTxHash);
      } else {
        setMintMessage("ok", "Transaction confirmed. The token ids were not found in the receipt; check the transaction on BscScan.", state.lastTxHash);
      }
      state.mintPending = false;
      loadChainState(true);
      refreshPrice();
      render();
    }).catch(function (e) {
      state.mintPending = false;
      setMintMessage("error", mintErrorMessage(e));
      updateMintButton();
    });
  }

  function galleryView(query, isNavigation) {
    if (isNavigation) {
      // Arriving via a link resets the filters; a rarity query applies it.
      // Re-renders caused by state changes (e.g. connecting a wallet)
      // preserve the filters the user already chose.
      state.gallery.status = "all";
      state.gallery.search = "";
      state.gallery.visible = 24;
      if (query && query.rarity) {
        var r = query.rarity.toLowerCase();
        state.gallery.rarity = ["legendary", "epic", "rare", "common"].indexOf(r) !== -1 ? r : "all";
      } else {
        state.gallery.rarity = "all";
      }
    } else if (query && query.rarity) {
      var r2 = query.rarity.toLowerCase();
      if (["legendary", "epic", "rare", "common"].indexOf(r2) !== -1) state.gallery.rarity = r2;
    }
    return '<section aria-labelledby="gallery-h"><h2 id="gallery-h">Gallery &mdash; The Codex</h2>' +
      '<div class="notice"><strong>Reconstruction notice.</strong> Gallery data outside the 12 Legends and the 2 verified pre-minted tokens (#1953 Kinoko Spirit and #2496 Three-Tail Kitsune) is a reconstruction, not the original Emergent genesis allocation table. Rarity counts are exact; individual names and traits for other tokens are generated deterministically for review only. <strong>Art note:</strong> every card shows its own final artwork &mdash; 12 Legend artworks plus 3,798 detailed composites from 32 trait-layer bases, all pinned to IPFS. The written traits under each card match the artwork by construction.</div>' +
      '<form class="filters" id="gallery-filters" aria-label="Gallery filters">' +
      '<label for="filter-rarity">Rarity<select id="filter-rarity">' +
      [["all", "All"], ["legendary", "Legendary"], ["epic", "Epic"], ["rare", "Rare"], ["common", "Common"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (state.gallery.rarity === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select></label>" +
      '<label for="filter-status">Status<select id="filter-status">' +
      [["all", "All"], ["available", "Available"], ["minted", "Minted"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (state.gallery.status === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select></label>" +
      '<label for="filter-search">Search token #<input id="filter-search" type="search" inputmode="numeric" placeholder="e.g. 1953" value="' + esc(state.gallery.search) + '"></label>' +
      "</form>" +
      '<p id="gallery-count" aria-live="polite"></p>' +
      '<div class="gallery-grid" id="gallery-results"></div>' +
      '<p><button type="button" class="btn-ghost" id="summon-more">Summon more</button></p></section>';
  }

  function filteredTokens() {
    var rarity = state.gallery.rarity;
    var status = state.gallery.status;
    var search = (state.gallery.search || "").trim();
    return DATA.tokens.filter(function (t) {
      if (rarity !== "all" && t.rarity.toLowerCase() !== rarity) return false;
      if (status === "available" && t.status !== "Available") return false;
      if (status === "minted" && t.status !== "Minted") return false;
      if (search !== "" && String(t.id).indexOf(search) === -1) return false;
      return true;
    });
  }

  function updateGalleryList() {
    var list = filteredTokens();
    var shown = list.slice(0, state.gallery.visible);
    var countEl = $("#gallery-count");
    var results = $("#gallery-results");
    if (!results) return;
    if (countEl) {
      var end = Math.min(state.gallery.visible, list.length);
      countEl.textContent = list.length === 0 ? "0 of 3,810" : ("1–" + end + " of " + list.length + " matching (3,810 total)");
    }
    results.innerHTML = shown.length ? shown.map(tokenCard).join("") : "<p>No tokens match these filters.</p>";
    var more = $("#summon-more");
    if (more) more.disabled = state.gallery.visible >= list.length;
  }

  function bindGallery() {
    var rarity = $("#filter-rarity"), status = $("#filter-status"), search = $("#filter-search");
    if (rarity) rarity.addEventListener("change", function () { state.gallery.rarity = rarity.value; state.gallery.visible = 24; updateGalleryList(); });
    if (status) status.addEventListener("change", function () { state.gallery.status = status.value; state.gallery.visible = 24; updateGalleryList(); });
    if (search) search.addEventListener("input", function () { state.gallery.search = search.value; state.gallery.visible = 24; updateGalleryList(); });
    var form = $("#gallery-filters");
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); });
    var more = $("#summon-more");
    if (more) more.addEventListener("click", function () { state.gallery.visible += 24; updateGalleryList(); });
    updateGalleryList();
  }

  /* ---------------- Token detail ---------------- */
  function tokenView(idStr) {
    var id = parseInt(idStr, 10);
    if (!idStr || isNaN(id) || id < 1 || id > DATA.cap || String(id) !== String(parseInt(idStr, 10))) {
      return notFoundView("This spirit has not awakened &mdash; or does not exist.", "Token ids in this collection run from 1 to 3,810.");
    }
    var t = tokensById[id];
    var traits = "<li><span>Element</span>" + esc(t.element) + "</li>" +
      "<li><span>Aura</span>" + esc(t.aura) + "</li>" +
      "<li><span>Eyes</span>" + esc(t.eyes) + "</li>" +
      "<li><span>Accessory</span>" + esc(t.accessory) + "</li>" +
      (t.palette ? "<li><span>Palette</span>" + esc(t.palette) + "</li>" : "");
    return '<section aria-labelledby="token-h"><p><a href="#/gallery">&larr; Back to the codex</a></p>' +
      '<div class="grid-2"><div>' + artFor(t, true) + "</div><div>" +
      "<p>Mythora #" + t.id + (t.edition ? " &middot; Edition " + esc(t.edition) : "") + "</p>" +
      '<h2 id="token-h">' + esc(t.name) + "</h2>" +
      "<p>" + rarityPill(t.rarity) + " " + (t.status === "Minted" ? '<span class="pill pill-minted">MINTED</span>' : t.status === "Burned" ? '<span class="pill pill-burned">BURNED</span>' : '<span class="pill">AVAILABLE</span>') + "</p>" +
      (t.role ? "<p>" + esc(t.role) + ".</p>" : "") +
      "<ul class=\"trait-list\">" + traits + "</ul>" +
      "<dl><dt>Status</dt><dd>" + esc(t.status) + "</dd>" +
      "<dt>Owner</dt><dd>—</dd>" +
            "<dt>Minted</dt><dd>" + esc(t.mintedAt || (t.preMinted ? "Before this reconstruction session (date not verified)" : "—")) + "</dd></dl>" +
      (t.status === "Available"
        ? '<p><a class="button btn-primary" href="#/mint">Mint now</a></p>'
        : "") +
      '<p><a href="https://x.com/intent/post?text=' + encodeURIComponent("Mythora #" + t.id + " — " + t.name + " from the Mythora collection.") + '" target="_blank" rel="noopener noreferrer">Share on X</a></p>' +
      "</div></div></section>";
  }

  /* ---------------- Transparency ---------------- */
  function transparencyView() {
    var c = counters();
    return '<section aria-labelledby="trans-h"><h2 id="trans-h">Transparency</h2>' +
      "<p>The permanent cap: <strong>3,810</strong>. The stated maximum supply is a constant in the displayed contract design. No function in that design can raise it.</p>" +
      '<div class="card"><h3>Fixed allocation (as claimed)</h3>' +
      "<p>All 3,810 tokens &mdash; tier, pool and traits &mdash; were described as committed at genesis with seed 3810, so anyone could re-run the generator and verify the table. That generator was not available for this reconstruction, so the claim could not be independently verified here.</p>" +
      "<table><thead><tr><th>Pool</th><th>Legendary</th><th>Epic</th><th>Rare</th><th>Common</th><th>Total</th></tr></thead><tbody>" +
      "<tr><td>Free Mint</td><td>0</td><td>93</td><td>306</td><td>1,506</td><td>1,905</td></tr>" +
      "<tr><td>Paid Mint</td><td>12</td><td>93</td><td>306</td><td>1,494</td><td>1,905</td></tr>" +
      "</tbody></table></div>" +
      '<div class="card"><h3>Rarity rules</h3><table><thead><tr><th>Tier</th><th>Count</th><th>Share</th><th>Voting weight</th></tr></thead><tbody>' +
      DATA.rarity.map(function (r) { return "<tr><td>" + esc(r.name) + "</td><td>" + r.count + "</td><td>" + r.share + "</td><td>" + esc(r.weight) + "</td></tr>"; }).join("") +
      "</tbody></table></div>" +
      '<div class="card"><h3>Mint mechanism</h3>' +
      "<p>One Mint flow for the whole collection: 3,810 tokens, no per-wallet limit in the deployed contract, per the owner&apos;s decision. Cards are drawn at random, including the Legendary cards. No mystery box: the card you get is picked at random from the unminted allocation at mint, with artwork, traits and edition shown right away.</p>" +
      "<p>Price follows the owner&apos;s rule: the first 1,905 tokens minted cost 0.00005 BNB each, and the remaining 1,905 cost 0.0005 BNB each. The displayed contract design described per-wallet limits; the deployed contract has no per-wallet limits, per the owner&apos;s decision.</p></div>" +
      '<div class="card"><h3>Fee breakdown</h3>' +
      "<p><strong>Free tier:</strong> 0 BNB price + a flat 0.00005 BNB mint fee sent to the creator, plus the normal BNB Chain network gas paid separately. The flat fee is a creator fee, not the network gas alone.</p>" +
      "<p><strong>Paid tier:</strong> 0.0005 BNB per token. All mint revenue is described as forwarded straight to the creator payout wallet in the same transaction.</p>" +
      "<p><strong>Secondary sales:</strong> 5% EIP-2981 royalty to the same creator wallet.</p></div>" +
      '<div class="card"><h3>Deployed contract</h3>' +
      "<dl><dt>Status</dt><dd><strong>DEPLOYED &mdash; VERIFIED ON-CHAIN</strong></dd>" +
      "<dt>Contract address</dt><dd><span class=\"address\">0x27Ba185e74b681c3e548D369C1B0792eD7D738a1</span><br><a href=\"https://bscscan.com/address/0x27Ba185e74b681c3e548D369C1B0792eD7D738a1\">View on BscScan</a></dd>" +
      "<dt>Network</dt><dd>BNB Smart Chain &middot; Chain 56</dd>" +
      "<dt>Name / Symbol</dt><dd>Mythora (MYTH)</dd>" +
      "<dt>Standard</dt><dd>ERC-721 + EIP-2981</dd>" +
      "<dt>Deployer / owner</dt><dd><span class=\"address\">0x0262e8e5E4584D8AB840fD950a6E2E0A414d4097</span><br>The owner&apos;s &ldquo;My Wallet&rdquo;.</dd>" +
      "<dt>payoutWallet</dt><dd><span class=\"address\">0x89c37649Ba3BAA9E1ce028612b7DE4e9c3a947B7</span><br>The owner&apos;s Agentic Wallet. Mint proceeds go here.</dd>" +
      "<dt>MAX_SUPPLY</dt><dd>3,810</dd>" +
      "<dt>Total minted</dt><dd data-live=\"totalMinted\">" + displayNum(c.minted, c.error) + "</dd>" +
      "<dt>Minting</dt><dd data-live=\"mintActive\">" + (c.error ? "—" : (c.active == null ? "…" : (c.active ? "On (mintActive is true)" : "Off (mintActive is false)"))) + "</dd>" +
      "<dt>Royalty</dt><dd>5% to the payout wallet (EIP-2981)</dd>" +
      "<dt>Verified on-chain</dt><dd>22:03 WIB, 29 Oct 2026. The deployed bytecode matches the verified contract draft.</dd></dl>" +
      "<p>No audit report or auditor name is claimed here: no independent audit exists. The full art set and metadata are pinned to IPFS (root CID <span class=\"address\">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span>); view them via the <a href=\"https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1\">Filebase gateway</a>. The contract baseURI is set on-chain (BaseURIUpdated event, <a href=\"https://bscscan.com/tx/0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e\" target=\"_blank\" rel=\"noopener noreferrer\">tx 0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e</a>). The BscScan link above points to the real deployed contract.</p></div>" +
      '<div class="card"><h3>Displayed contract, summarised in plain words</h3>' +
      "<p>The code shown on the preview Transparency page (summarised here, not reproduced) used fixed constants for the 3,810 cap, the two 1,905 pools, the 0.00005 BNB free fee, the 0.0005 BNB paid price, and the per-wallet limits of 2 free and 10 paid. It named mint operations for the free pool (one token per call) and the paid pool (one to five per call), owner-only controls to switch minting on, change the metadata base address, and change the payout wallet, a safety withdrawal that always sends any stray balance to the payout wallet, and royalty handling. Minting was described as starting switched off, with a reentrancy guard on the mint operations and revenue forwarded in the same transaction.</p>" +
      "<p>What was not in the displayed design: no allowlist or phase logic, no on-chain randomness, and no on-chain enforcement of which rarity or pool a given token id belongs to &mdash; token ids ran in mint order, so rarity and pool mapping depended on off-chain metadata. The owner could also change the metadata base address and the payout wallet at any time in the displayed design, with no freeze or timelock shown.</p></div>" +
      '<div class="warning" role="note"><h3>Under review</h3>' +
      "<p><strong>Voting functions were not present in the displayed contract.</strong> Voting on this page is not recorded on-chain and is not a live contract feature. A decision is still needed for voting: remove the claim, postpone it, or build it separately. There is no Fusion feature: it was removed at the owner's request, and the revised contract draft has no fusion or burn functions.</p></div>" +
      '<div class="card"><h3>Launch checklist</h3><ol>' +
      "<li>Final creator review of this page and the allocation table.</li>" +
      "<li><strong>Done:</strong> deployed to BNB Smart Chain on 29 Oct 2026 (no testnet rehearsal, per the owner&apos;s decision) and verified on-chain.</li>" +
      "<li><strong>Done:</strong> full art set + metadata pinned to IPFS on 29 Oct 2026. Root CID <span class=\"address\">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span> (<a href=\"https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1\">gateway</a>). The contract baseURI is set on-chain (BaseURIUpdated event, <a href=\"https://bscscan.com/tx/0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e\" target=\"_blank\" rel=\"noopener noreferrer\">tx 0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e</a>), and the owner has called setMintActive \u2014 minting is open.</li>" +
      "<li>Verify the contract source on BscScan.</li>" +
      "<li><strong>Done:</strong> owner called setMintActive on 29 Oct 2026 \u2014 the drop is live (<a href=\"https://bscscan.com/tx/0xbd71bc2ff0953b6707830a628693315cb746b678d55f4103506fc6cc9ae4b0e8\" target=\"_blank\" rel=\"noopener noreferrer\">tx 0xbd71bc2ff0953b6707830a628693315cb746b678d55f4103506fc6cc9ae4b0e8</a>).</li>" +
      "</ol><p>The contract is deployed, the baseURI is set, and minting is open. No independent audit exists.</p></div>" +
      '<div class="card"><h3>Metadata standard</h3><p>Every token exposes standard ERC-721 metadata JSON &mdash; name, description, image and attributes. The full set is pinned to IPFS at root CID <span class="address">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span> (gateway: <a href="https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1">metadata/1</a>). The baseURI is set on-chain to <span class="address">ipfs://bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/</span> (BaseURIUpdated event, <a href=\"https://bscscan.com/tx/0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e\" target=\"_blank\" rel=\"noopener noreferrer\">tx 0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e</a>).</p></div></section>';
  }

  /* ---------------- Governance ---------------- */
  function governanceView() {
    var holds = state.sessionMintedIds.length > 0;
    var controls;
    if (!state.wallet) {
      controls = '<div class="callout"><p><strong>Hold a Mythora to vote.</strong></p>' +
        '<p>Connect your wallet to see the voting controls.</p>' +
        '<button type="button" class="btn-primary" id="gov-connect">Connect Wallet</button></div>';
    } else if (!holds) {
      controls = '<div class="callout"><p><strong>Hold a Mythora to vote.</strong></p>' +
        '<p>This wallet holds no Mythora token in this session yet.</p>' +
        '<p><a class="button btn-primary" href="#/mint">Mint your first guardian</a></p></div>';
    } else {
      controls = '<div class="callout"><p><strong>Your voting power: 1</strong> &mdash; one wallet, one vote. Your session holding: ' + state.sessionMintedIds.length + ' token(s).</p>' +
        "<p>Votes on this page are counted in this browser session only and are not recorded on-chain.</p></div>";
    }
    var cards = DATA.proposals.map(function (p, idx) {
      var count = state.votes[p.slug];
      var voted = state.currentVote === p.slug;
      var canVote = !!(state.wallet && holds);
      return '<div class="card"><h3>' + esc(p.name) + "</h3>" +
        '<p class="vote-count" aria-live="polite">' + count + ' vote' + (count === 1 ? "" : "s") + "</p>" +
        (voted ? '<p><span class="pill pill-minted">VOTED</span> You voted for this proposal.</p>' : "") +
        (canVote ? '<button type="button" class="btn-primary vote-btn" data-index="' + idx + '">Vote</button>' : "") +
        "</div>";
    }).join("");
    return '<section aria-labelledby="gov-h"><h2 id="gov-h">Design Voting</h2>' +
      "<p>Holders decide what the forges craft next.</p>" +
      "<p>Weights: Legendary 10x &middot; Epic 4x &middot; Rare 2x &middot; Common 1x. No deadline, proposal id, or winner history is shown, because none was verified.</p>" +
      controls +
      '<div class="grid-3" style="margin-top:1rem">' + cards + "</div>" +
      '<section class="card" style="margin-top:1rem"><h3>Holder community</h3><p>Planned. No gated channels, links, or holder-only interface are provided in this reconstruction.</p></section></section>';
  }

  function bindGovernance() {
    var connectBtn = $("#gov-connect");
    if (connectBtn) connectBtn.addEventListener("click", connectWallet);
    $all(".vote-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var proposal = DATA.proposals[parseInt(btn.getAttribute("data-index"), 10)];
        if (!proposal) return;
        var slug = proposal.slug;
        if (state.currentVote) state.votes[state.currentVote]--;
        state.votes[slug]++;
        state.currentVote = slug;
        render();
        announce("Voted for " + proposal.name + ".");
      });
    });
  }

  /* ---------------- Not found ---------------- */
  function notFoundView(message, detail) {
    return '<section aria-labelledby="nf-h"><h2 id="nf-h">Page not found</h2>' +
      "<p>" + (message || "The page you asked for does not exist in this reconstruction.") + "</p>" +
      (detail ? "<p>" + detail + "</p>" : "") +
      '<p><a href="#/">Back to the home page</a> &middot; <a href="#/gallery">Back to the codex</a></p></section>';
  }

  /* ---------------- Router ---------------- */
  var lastHashKey = null;
  function render() {
    var hashKey = window.location.hash || "#/";
    var isNavigation = hashKey !== lastHashKey;
    lastHashKey = hashKey;
    renderHeaderWallet();
    var parsed = parseHash();
    var path = parsed.path;
    var app = $("#app");
    setNav(path);
    if (path === "/" || path === "") {
      app.innerHTML = homeView();
    } else if (path === "/mint") {
      app.innerHTML = mintView();
      bindMint();
    } else if (path === "/gallery") {
      app.innerHTML = galleryView(parsed.query, isNavigation);
      bindGallery();
    } else if (path.indexOf("/nft/") === 0) {
      app.innerHTML = tokenView(path.replace("/nft/", ""));
    } else if (path === "/transparency") {
      app.innerHTML = transparencyView();
    } else if (path === "/governance") {
      app.innerHTML = governanceView();
      bindGovernance();
    } else {
      app.innerHTML = notFoundView();
    }
    var heading = app.querySelector("h1, h2");
    if (heading) document.title = heading.textContent.trim() + " — Mythora (Reconstruction)";
    window.scrollTo(0, 0);
    // Keep chain numbers fresh without hammering the RPC: refresh at
    // most once a minute while the user navigates.
    if (chainState.loaded && Date.now() - chainState.loadedAt > 60000) loadChainState(true);
    else syncChainUi();
  }

  window.addEventListener("hashchange", render);

  // Exposed only for local verification of this reconstruction.
  window.MYTHORA_TEST = { state: state, data: DATA, counters: counters, tokensById: tokensById, chainState: chainState };

  render();
  loadChainState();
})();
