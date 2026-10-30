/* Mythora — client-side hash routing and live chain data.
 * The Mint view presents minting through the visitor's Binance
 * Agentic Wallet agent via a copy-paste prompt and CLI commands.
 * Chain numbers and prices are read live via public RPC.
 * The contract's mint() is permissionless; the agent path is one way this
 * page presents minting, not an on-chain restriction.
 * No seed phrase or private key is ever asked for or handled here. */
(function () {
  "use strict";

  var DATA = window.MYTHORA_DATA;
  var tokensById = {};
  DATA.tokens.forEach(function (t) { tokensById[t.id] = t; });

  /* Deployed contract (behavior verified on-chain 29 Oct 2026; source verified on BscScan 30 Oct 2026; minting open). */
  var CONTRACT_ADDRESS = "0x27Ba185e74b681c3e548D369C1B0792eD7D738a1";
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
    "function balanceOf(address owner) view returns (uint256)",
    "function mint(uint256 quantity) payable",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
  ];
  /* mint(uint256) selector, computed with ethers id("mint(uint256)") and
   * verified against the deployed contract ABI. */
  var MINT_SELECTOR = "0xa0712d68";

  var state = {
    gallery: { rarity: "all", status: "all", search: "", visible: 24 },
    checkWallet: null // { address, balance, bnb, error } from the last lookup
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

  /* Current mintPrice(1), read live; null = not loaded yet. */
  var priceState = { loading: false, loaded: false, error: false, wei: null };

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
  var readProvider = null;
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
      return Promise.reject(new Error("Chain-reading library did not load."));
    }
    readContractPromise = (function tryNext(i) {
      if (i >= RPC_URLS.length) throw new Error("No public RPC answered.");
      var provider = new ethers.JsonRpcProvider(RPC_URLS[i]);
      return withTimeout(provider.getBlockNumber(), 10000).then(function () {
        readProvider = provider;
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

  function loadMintPrice(force) {
    if (priceState.loading) return Promise.resolve();
    if (priceState.loaded && !force) return Promise.resolve();
    priceState.loading = true;
    return getReadContract().then(function (c) {
      return c.mintPrice(1);
    }).then(function (price) {
      priceState.wei = price.toString();
      priceState.loaded = true;
      priceState.error = false;
    }).catch(function () {
      priceState.error = true;
      priceState.loaded = false;
    }).then(function () {
      priceState.loading = false;
      syncPriceUi();
    });
  }

  function syncPriceUi() {
    var text = priceState.error ? "—" : (priceState.wei == null ? "…" : fmtWei(priceState.wei) + " BNB");
    $all('[data-live="price1"]').forEach(function (el) { el.textContent = text; });
    var retry = $("#price-retry");
    if (retry) retry.style.display = priceState.error ? "" : "none";
    var note = $("#price-note");
    if (note) note.style.display = priceState.error ? "" : "none";
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
    var note = $("#chain-note");
    if (note) note.style.display = chainState.error ? "" : "none";
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
    return '<article class="token-card token-' + token.rarity.toLowerCase() + '">' +
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

  /* ---------------- Home ---------------- */
  function homeView() {
    var legends = DATA.tokens.filter(function (t) { return t.rarity === "Legendary"; });
    var featured = tokensById[158];
    var oni = tokensById[672];
    var tengu = tokensById[686];
    var marquee = legends.map(function (t) { return '<span class="cover-cell">' + artFor(t) + "</span>"; }).join("");
    var rows = DATA.rarity.map(function (r) {
      return "<tr><td>" + esc(r.name) + "</td><td>" + r.share + "</td><td>" + r.count + "</td></tr>";
    }).join("");
    return '<div class="banner" role="note"><strong>CONTRACT DEPLOYED &bull; SOURCE VERIFIED ON BSCSCAN</strong>' +
      "<p>The Mythora contract is deployed on BNB Smart Chain: <a href=\"https://bscscan.com/address/0x27Ba185e74b681c3e548D369C1B0792eD7D738a1\" target=\"_blank\" rel=\"noopener noreferrer\">0x27Ba185e74b681c3e548D369C1B0792eD7D738a1</a>. Minting is open on-chain. Mint through your Binance Agentic Wallet agent.</p></div>" +
      '<section class="cover" aria-label="Mythora cover">' +
      '<div class="cover-stars" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>' +
      '<p class="eyebrow">PERMANENT 3,810 CAP &bull; BNB SMART CHAIN</p>' +
      '<h1 class="cover-title">AWAKEN YOUR CHIBI YOKAI</h1>' +
      '<p class="lede">A collector-first drop of 3,810 mythic chibi guardians on BNB Smart Chain. You get your card right away, and every rarity rule published in the open.</p>' +
      '<p class="price-badge"><strong>EARLY PRICE &middot; 0.00005 BNB</strong><span>for the first 1,905 mints &middot; then 0.0005 BNB each</span></p>' +
      '<div class="hero-actions"><a class="button btn-primary mint-big" href="#/mint">Enter the Mint</a>' +
      '<a class="button btn-ghost" href="#/transparency">Read the Rules</a></div>' +
      '<p class="trust-row"><span><b>&#10003;</b> Source verified on BscScan</span><span><b>&#10003;</b> Art &amp; metadata pinned to IPFS</span><span><b>&#10003;</b> Fixed supply of 3,810</span></p>' +
      '<div class="cover-float">' +
      '<figure class="float-card float-side float-left"><a href="#/nft/672">' + artFor(oni) + '</a><figcaption>Oni, the Royal Warden</figcaption></figure>' +
      '<figure class="float-card float-center"><a href="#/nft/158">' + artFor(featured) + '</a><figcaption>Featured Legend &middot; Edition ' + esc(featured.edition) + "<br>" + esc(featured.name) + "</figcaption></figure>" +
      '<figure class="float-card float-side float-right"><a href="#/nft/686">' + artFor(tengu) + "</a><figcaption>Tengu, the Gale Herald</figcaption></figure>" +
      "</div>" +
      '<div class="cover-marquee" aria-hidden="true"><div class="cover-track">' + marquee + marquee + "</div></div></section>" +
      '<p class="stats-label"><span class="live-dot"></span> LIVE &middot; READ FROM BNB SMART CHAIN</p>' +
      countersHtml() +
      '<section aria-labelledby="legends-h"><h2 id="legends-h">The Twelve Legends</h2>' +
      '<p>Twelve 1-of-1 Mythic Yokai, each with a hand-crafted design, an animated celestial aura, its own role and a custom edition number. Every mint draws at random from the remaining supply &mdash; a Legend can appear on any mint, including yours.</p>' +
      '<div class="legend-grid">' + legends.map(tokenCard).join("") + "</div>" +
      '<p><a href="#/gallery?rarity=legendary">Meet all twelve &rarr;</a></p></section>' +
      '<section aria-labelledby="rarity-h"><h2 id="rarity-h">Rarity, published in full</h2>' +
      "<p>The allocation was committed at genesis and can never change &mdash; every tier and every count, published. The gallery allocation outside the 12 Legends is generated deterministically and is not the original genesis table.</p>" +
      '<div class="card"><div class="table-scroll"><table><thead><tr><th>Tier</th><th>Share</th><th>Count</th></tr></thead><tbody>' + rows + "</tbody></table></div></div></section>" +
      '<section aria-labelledby="utility-h"><h2 id="utility-h">Real utility, from day one</h2><div class="grid-3">' +
      '<div class="card"><h3>Holder community</h3><p>Planned: owning a Mythora is described as unlocking the holder community. No gated channels or holder-only links are provided on this site.</p></div>' +
            '<div class="card"><h3>Mythora on X</h3><p>Daily lore, drop alerts and holder-only events on the official profile.</p><p><a href="' + DATA.xUrl + '" target="_blank" rel="noopener noreferrer">Follow @MythoraNFT on X</a></p></div>' +
      "</div></section>" +
      '<section class="card" style="text-align:center"><h2>3,810. Forever. Nothing more.</h2>' +
      "<p>The cap is written into the contract and cannot be raised &mdash; scarcity you can verify, not a promise.</p>" +
      '<p><a class="button btn-primary" href="#/mint">Mint yours</a></p></section>';
  }

  /* ---------------- Mint: through your agent ---------------- */

  /* Minting is presented through the visitor's Binance Agentic Wallet
   * agent, via the copy-paste prompt and baw CLI commands below.
   * The contract's mint() is permissionless: it does not check for an
   * Agent ID and has no per-wallet limit. The agent path is presentation,
   * not an on-chain restriction. */

  var AGENT_PROMPT =
    "Mint a Mythora token for my wallet using my Binance Agentic Wallet. " +
    "Contract: 0x27Ba185e74b681c3e548D369C1B0792eD7D738a1 on BNB Smart Chain (56). " +
    "First read mintPrice(1) from the contract and send exactly that value with mint(1) " +
    "(selector 0xa0712d68). Preview with baw, then execute. " +
    "Full skill: https://puzzlehave.fun/mythora-skill.md";

  var BAW_CLI =
    "baw wallet sign-in\n\n" +
    "baw contract-call preview --binanceChainId 56 --from <your-wallet> " +
    "--to 0x27Ba185e74b681c3e548D369C1B0792eD7D738a1 --value <mintPrice-wei> " +
    "--inputData 0xa0712d680000000000000000000000000000000000000000000000000000000000000001\n\n" +
    "baw contract-call execute --requestId <from-preview>";

  function copyText(text, btn) {
    function done(ok) {
      if (!btn) return;
      btn.textContent = ok ? "Copied" : "Copy failed — select the text manually";
      setTimeout(function () { btn.textContent = "Copy"; }, 2000);
      announce(ok ? "Copied to clipboard." : "Copy failed.");
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else if (typeof document !== "undefined") {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    } else {
      done(false);
    }
  }

  function agentPathHtml() {
    return mintStepsHtml() + promptBlockHtml() + cliBlockHtml() + checkWalletHtml() +
      '<p class="notice">How this page relates to the contract: the contract&apos;s mint() is permissionless &mdash; it does not check for an Agent ID and has no per-wallet limit. Minting through your agent is how this page presents minting; it is not an on-chain restriction. Anyone can still call mint() on the contract directly.</p>';
  }

  /* ---------------- Path B: mint with your agent ---------------- */

  function mintStatsHtml() {
    var c = counters();
    return '<p class="stats-label"><span class="live-dot"></span> LIVE CHAIN STATS</p>' +
      '<div class="counters" aria-label="Live chain stats">' +
      '<div class="counter"><strong data-counter="minted">' + displayNum(c.minted, c.error) + '</strong><span>MINTED</span></div>' +
      '<div class="counter"><strong data-counter="remaining">' + displayNum(c.remaining, c.error) + '</strong><span>REMAINING</span></div>' +
      '<div class="counter"><strong>' + c.cap + '</strong><span>SUPPLY</span></div>' +
      '<div class="counter counter-price"><strong data-live="price1">' + (priceState.error ? "—" : (priceState.wei == null ? "…" : fmtWei(priceState.wei) + " BNB")) + '</strong><span>PRICE FOR 1 TOKEN</span></div>' +
      "</div>" +
      '<p class="mint-totals"><strong>Total Item:</strong> ' + c.cap + ' &nbsp;&middot;&nbsp; <strong>Sudah Mint:</strong> <span data-counter="minted">' + displayNum(c.minted, c.error) + '</span> &nbsp;&middot;&nbsp; <strong>Sisa:</strong> <span data-counter="remaining">' + displayNum(c.remaining, c.error) + "</span></p>" +
      '<p class="notice" id="chain-note" style="display:' + (c.error ? "" : "none") + '">The on-chain numbers could not be read. Check your connection. <button type="button" class="btn-ghost" id="chain-retry">Retry</button></p>' +
      '<p class="notice" id="price-note" style="display:' + (priceState.error ? "" : "none") + '">The current price could not be read. <button type="button" class="btn-ghost" id="price-retry">Retry price</button></p>' +
      '<p>Minting: <span data-live="mintActive">' + (c.error ? "—" : (c.active == null ? "…" : (c.active ? "On (mintActive is true)" : "Off (mintActive is false)"))) + '</span> &middot; Price rule: the first 1,905 mints cost <strong>0.00005 BNB</strong> each, then 0.0005 BNB each. The price above is read live from the contract.</p>';
  }

  function mintStepsHtml() {
    return '<div class="card"><h3>How minting works here</h3><ol class="steps">' +
      "<li><strong>01 &middot; Fund your Agentic Wallet.</strong> Your agent mints from your own wallet, so fund it with BNB for the price plus network gas. No Agent ID is needed: the contract does not check for one.</li>" +
      "<li><strong>02 &middot; Prompt your agent.</strong> Send the prompt below to your agent. It reads the exact price from the contract, previews the call, then executes. For more than one token, tell your agent the quantity &mdash; it must read mintPrice for that quantity and send exactly that value.</li>" +
      "<li><strong>03 &middot; The token is yours.</strong> The token id is drawn at random on-chain from the remaining supply, and the token goes directly to your wallet.</li>" +
      "</ol></div>";
  }

  function promptBlockHtml() {
    return '<div class="card mint-path-primary"><div class="prompt-head"><h3>PROMPT FOR YOUR AGENT</h3>' +
      '<button type="button" class="btn-ghost" id="copy-prompt-btn">Copy</button></div>' +
      '<p class="prompt-hint">Copy the prompt, paste it to your agent &mdash; done.</p>' +
      '<pre class="code-block" id="agent-prompt">' + esc(AGENT_PROMPT) + "</pre>" +
      '<p>Full agent instructions: <a href="https://puzzlehave.fun/mythora-skill.md">mythora-skill.md</a></p></div>';
  }

  function cliBlockHtml() {
    return '<div class="card"><div class="prompt-head"><h3>OR VIA THE BAW CLI</h3>' +
      '<button type="button" class="btn-ghost" id="copy-cli-btn">Copy</button></div>' +
      '<pre class="code-block" id="baw-cli">' + esc(BAW_CLI) + "</pre>" +
      "<p>Quantity 1 example. The inputData is the mint(uint256) selector followed by the 32-byte big-endian quantity. For a different quantity, re-read mintPrice for that quantity and encode it the same way.</p></div>";
  }

  function checkWalletHtml() {
    var result = "";
    var cw = state.checkWallet;
    if (cw) {
      if (cw.error) {
        result = '<p class="mint-status mint-status-error" role="status">' + esc(cw.error) + "</p>";
      } else {
        result = '<p role="status">Wallet <a href="https://bscscan.com/address/' + esc(cw.address) + '" target="_blank" rel="noopener noreferrer">' + esc(cw.address) + "</a> holds <strong>" + cw.balance + "</strong> Mythora token(s) and <strong>" + esc(cw.bnb) + " BNB</strong>.</p>";
      }
    }
    return '<div class="card"><h3>CHECK A WALLET</h3>' +
      "<p>Enter any BNB Chain wallet address to see how many Mythora tokens it holds.</p>" +
      '<div class="check-row"><input id="check-address" type="text" inputmode="latin" placeholder="0x…" autocomplete="off" spellcheck="false" aria-label="Wallet address to check" value="' + esc(cw ? cw.address : "") + '">' +
      '<button type="button" class="btn-primary" id="check-wallet-btn">Check</button></div>' +
      '<div id="check-wallet-result">' + result + "</div></div>";
  }

  function mintView() {
    var oddsRows = DATA.rarity.map(function (r) {
      return "<tr><td>" + esc(r.name) + "</td><td>" + r.count + "</td><td>" + r.share + "</td></tr>";
    }).join("");
    return '<section aria-labelledby="mint-h"><h2 id="mint-h">Mint Portal</h2>' +
      "<p>Mint through your Binance Agentic Wallet agent. Send the prompt below to your agent, or run the CLI commands &mdash; the token goes straight to your wallet.</p>" +
      mintStatsHtml() +
      '<p class="mint-path-label">MINT WITH YOUR AGENT</p>' +
      agentPathHtml() +
      '<div class="card odds"><h3>Your odds on every mint</h3>' +
      "<p>Odds below are the collection counts. Every mint draws a random remaining token id on-chain, and every remaining card &mdash; Legendary included &mdash; can be drawn.</p>" +
      "<table><thead><tr><th>Tier</th><th>Count</th><th>Share</th></tr></thead><tbody>" + oddsRows + "</tbody></table></div>" +
      '<p><a href="#/gallery">Browse the codex</a> &middot; <a href="#/transparency">Read the mint rules</a></p></section>';
  }

  function bindMint() {
    var copyPrompt = $("#copy-prompt-btn");
    if (copyPrompt) copyPrompt.addEventListener("click", function () { copyText(AGENT_PROMPT, copyPrompt); });
    var copyCli = $("#copy-cli-btn");
    if (copyCli) copyCli.addEventListener("click", function () { copyText(BAW_CLI, copyCli); });
    var retry = $("#chain-retry");
    if (retry) retry.addEventListener("click", function () { loadChainState(true); loadMintPrice(true); });
    var priceRetry = $("#price-retry");
    if (priceRetry) priceRetry.addEventListener("click", function () { priceState.loaded = false; priceState.error = false; loadMintPrice(true); });
    var checkBtn = $("#check-wallet-btn");
    if (checkBtn) checkBtn.addEventListener("click", runCheckWallet);
    var checkInput = $("#check-address");
    if (checkInput) checkInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runCheckWallet(); } });
    loadMintPrice();
    syncPriceUi();
  }

  function runCheckWallet() {
    var input = $("#check-address");
    var slot = $("#check-wallet-result");
    var address = input ? input.value.trim() : "";
    if (typeof ethers === "undefined" || !ethers.isAddress || !ethers.isAddress(address)) {
      state.checkWallet = { address: address, error: "Enter a valid 0x wallet address." };
      if (slot) slot.innerHTML = '<p class="mint-status mint-status-error" role="status">Enter a valid 0x wallet address.</p>';
      announce("Enter a valid 0x wallet address.");
      return;
    }
    var checksummed = ethers.getAddress(address);
    if (slot) slot.innerHTML = "<p>Reading the chain…</p>";
    getReadContract().then(function (c) {
      return Promise.all([c.balanceOf(checksummed), readProvider.getBalance(checksummed)]);
    }).then(function (res) {
      state.checkWallet = { address: checksummed, balance: Number(res[0]), bnb: fmtWei(res[1].toString()), error: null };
      var el = $("#check-wallet-result");
      if (el) el.innerHTML = '<p role="status">Wallet <a href="https://bscscan.com/address/' + esc(checksummed) + '" target="_blank" rel="noopener noreferrer">' + esc(checksummed) + "</a> holds <strong>" + state.checkWallet.balance + "</strong> Mythora token(s) and <strong>" + esc(state.checkWallet.bnb) + " BNB</strong>.</p>";
      announce("Wallet checked.");
    }).catch(function () {
      state.checkWallet = { address: checksummed, error: "Could not read the chain. Check your connection and try again." };
      var el2 = $("#check-wallet-result");
      if (el2) el2.innerHTML = '<p class="mint-status mint-status-error" role="status">Could not read the chain. Check your connection and try again.</p>';
      announce("Could not read the chain.");
    });
  }

  function galleryView(query, isNavigation) {
    if (isNavigation) {
      // Arriving via a link resets the filters; a rarity query applies it.
      // Re-renders caused by state changes
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
            "<dt>Minted</dt><dd>" + esc(t.mintedAt || (t.preMinted ? "Date not verified" : "—")) + "</dd></dl>" +
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
      "<p>All 3,810 tokens &mdash; tier, pool and traits &mdash; were described as committed at genesis with seed 3810, so anyone could re-run the generator and verify the table. That generator was not available here, so the claim could not be independently verified.</p>" +
      "<div class=\"table-scroll\"><table><thead><tr><th>Pool</th><th>Legendary</th><th>Epic</th><th>Rare</th><th>Common</th><th>Total</th></tr></thead><tbody>" +
      "<tr><td>Free Mint</td><td>0</td><td>93</td><td>306</td><td>1,506</td><td>1,905</td></tr>" +
      "<tr><td>Paid Mint</td><td>12</td><td>93</td><td>306</td><td>1,494</td><td>1,905</td></tr>" +
      "</tbody></table></div></div>" +
      '<div class="card"><h3>Rarity rules</h3><div class="table-scroll"><table><thead><tr><th>Tier</th><th>Count</th><th>Share</th></tr></thead><tbody>' +
      DATA.rarity.map(function (r) { return "<tr><td>" + esc(r.name) + "</td><td>" + r.count + "</td><td>" + r.share + "</td></tr>"; }).join("") +
      "</tbody></table></div></div>" +
      '<div class="card"><h3>Mint mechanism</h3>' +
      "<p>One Mint flow for the whole collection: 3,810 tokens, no per-wallet limit in the deployed contract, per the owner&apos;s decision. Cards are drawn at random, including the Legendary cards. No mystery box: the card you get is picked at random from the unminted allocation at mint, with artwork, traits and edition shown right away.</p>" +
      "<p>Price follows the owner&apos;s rule: the first 1,905 tokens minted cost 0.00005 BNB each, and the remaining 1,905 cost 0.0005 BNB each. The displayed contract design described per-wallet limits; the deployed contract has no per-wallet limits, per the owner&apos;s decision.</p></div>" +
      '<div class="card"><h3>Fee breakdown</h3>' +
      "<p><strong>Free tier:</strong> 0 BNB price + a flat 0.00005 BNB mint fee sent to the creator, plus the normal BNB Chain network gas paid separately. The flat fee is a creator fee, not the network gas alone.</p>" +
      "<p><strong>Paid tier:</strong> 0.0005 BNB per token. All mint revenue is described as forwarded straight to the creator payout wallet in the same transaction.</p>" +
      "<p><strong>Secondary sales:</strong> 5% EIP-2981 royalty to the same creator wallet.</p></div>" +
      '<div class="card"><h3>Deployed contract</h3>' +
      "<dl><dt>Status</dt><dd><strong>DEPLOYED &mdash; SOURCE VERIFIED ON BSCSCAN</strong></dd>" +
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
      "<dt>Verified on-chain</dt><dd>22:03 WIB, 29 Oct 2026. The deployed bytecode matches the verified contract draft.</dd>" +
      "<dt>Source code verified</dt><dd>01:52 WIB, 30 Oct 2026. BscScan returned &ldquo;Pass - Verified&rdquo;; the published source matches the deployed bytecode.</dd></dl>" +
      "<p>No audit report or auditor name is claimed here: no independent audit exists. The full art set and metadata are pinned to IPFS (root CID <span class=\"address\">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span>); view them via the <a href=\"https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1\">Filebase gateway</a>. The contract baseURI is set on-chain (BaseURIUpdated event, <a href=\"https://bscscan.com/tx/0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e\" target=\"_blank\" rel=\"noopener noreferrer\">tx 0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e</a>). The BscScan link above points to the real deployed contract.</p></div>" +
      '<div class="card"><h3>Displayed contract, summarised in plain words</h3>' +
      "<p>The code shown on the preview Transparency page (summarised here, not reproduced) used fixed constants for the 3,810 cap, the two 1,905 pools, the 0.00005 BNB free fee, the 0.0005 BNB paid price, and the per-wallet limits of 2 free and 10 paid. It named mint operations for the free pool (one token per call) and the paid pool (one to five per call), owner-only controls to switch minting on, change the metadata base address, and change the payout wallet, a safety withdrawal that always sends any stray balance to the payout wallet, and royalty handling. Minting was described as starting switched off, with a reentrancy guard on the mint operations and revenue forwarded in the same transaction.</p>" +
      "<p>What was not in the displayed design: no allowlist or phase logic, no on-chain randomness, and no on-chain enforcement of which rarity or pool a given token id belongs to &mdash; token ids ran in mint order, so rarity and pool mapping depended on off-chain metadata. The owner could also change the metadata base address and the payout wallet at any time in the displayed design, with no freeze or timelock shown.</p></div>" +
      '<div class="warning" role="note"><h3>Under review</h3>' +
      "<p>There is no Fusion feature: it was removed at the owner's request, and the revised contract draft has no fusion or burn functions.</p></div>" +
      '<div class="card"><h3>Launch checklist</h3><ol>' +
      "<li>Final creator review of this page and the allocation table.</li>" +
      "<li><strong>Done:</strong> deployed to BNB Smart Chain on 29 Oct 2026 (no testnet rehearsal, per the owner&apos;s decision) and behavior-verified on-chain; source code verified on BscScan 30 Oct 2026.</li>" +
      "<li><strong>Done:</strong> full art set + metadata pinned to IPFS on 29 Oct 2026. Root CID <span class=\"address\">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span> (<a href=\"https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1\">gateway</a>). The contract baseURI is set on-chain (BaseURIUpdated event, <a href=\"https://bscscan.com/tx/0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e\" target=\"_blank\" rel=\"noopener noreferrer\">tx 0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e</a>), and the owner has called setMintActive \u2014 minting is open.</li>" +
      "<li><strong>Done:</strong> contract source verified on BscScan on 30 Oct 2026.</li>" +
      "<li><strong>Done:</strong> owner called setMintActive on 29 Oct 2026 \u2014 the drop is live (<a href=\"https://bscscan.com/tx/0xbd71bc2ff0953b6707830a628693315cb746b678d55f4103506fc6cc9ae4b0e8\" target=\"_blank\" rel=\"noopener noreferrer\">tx 0xbd71bc2ff0953b6707830a628693315cb746b678d55f4103506fc6cc9ae4b0e8</a>).</li>" +
      "</ol><p>The contract is deployed, the baseURI is set, and minting is open. No independent audit exists.</p></div>" +
      '<div class="card"><h3>Metadata standard</h3><p>Every token exposes standard ERC-721 metadata JSON &mdash; name, description, image and attributes. The full set is pinned to IPFS at root CID <span class="address">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span> (gateway: <a href="https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1">metadata/1</a>). The baseURI is set on-chain to <span class="address">ipfs://bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/</span> (BaseURIUpdated event, <a href=\"https://bscscan.com/tx/0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e\" target=\"_blank\" rel=\"noopener noreferrer\">tx 0xeb46f1cbfd65f748870955993358ded54e9f1b7b66856ac2073b66dfaa7ef39e</a>).</p></div></section>';
  }

  /* ---------------- Not found ---------------- */
  function notFoundView(message, detail) {
    return '<section aria-labelledby="nf-h"><h2 id="nf-h">Page not found</h2>' +
      "<p>" + (message || "The page you asked for does not exist on this site.") + "</p>" +
      (detail ? "<p>" + detail + "</p>" : "") +
      '<p><a href="#/">Back to the home page</a> &middot; <a href="#/gallery">Back to the codex</a></p></section>';
  }

  /* ---------------- Router ---------------- */
  var lastHashKey = null;
  function render() {
    var hashKey = window.location.hash || "#/";
    var isNavigation = hashKey !== lastHashKey;
    lastHashKey = hashKey;
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
    } else {
      app.innerHTML = notFoundView();
    }
    var heading = app.querySelector("h1, h2");
    if (heading) document.title = heading.textContent.trim() + " — Mythora";
    window.scrollTo(0, 0);
    // Keep chain numbers fresh without hammering the RPC: refresh at
    // most once a minute while the user navigates.
    if (chainState.loaded && Date.now() - chainState.loadedAt > 60000) loadChainState(true);
    else syncChainUi();
  }

  window.addEventListener("hashchange", render);

  // Exposed for local testing only.
  window.MYTHORA_TEST = { state: state, data: DATA, counters: counters, tokensById: tokensById, chainState: chainState };

  render();
  loadChainState();
  loadMintPrice();
})();
