/* Mythora reconstruction — client-side hash routing, demo simulation only.
 * No real wallet, no signing, no network calls, no BNB moves.
 * All state is in-memory for this browser session only. */
(function () {
  "use strict";

  var DATA = window.MYTHORA_DATA;
  var tokensById = {};
  DATA.tokens.forEach(function (t) { tokensById[t.id] = t; });

  var state = {
    wallet: null, // { address, truncated }
    freeMinted: 2, // the two pre-minted tokens count in the Free pool
    paidMinted: 0,
    sessionMintedIds: [],
    lastMintedIds: [],
    votes: { "celestial-kitsune": 0, "raijin-dragon": 0, "moonlit-yuki-onna": 0 },
    currentVote: null,
    mintQty: 1,
    gallery: { rarity: "all", status: "all", search: "", visible: 24 }
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

  function connectDemoWallet() {
    var bytes = new Uint8Array(20);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < 20; i++) bytes[i] = Math.floor(Math.random() * 256);
    var hex = Array.prototype.map.call(bytes, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
    var address = "0x" + hex;
    state.wallet = { address: address, truncated: truncated(address) };
    render();
    announce("Demo wallet connected. This is a simulation address only.");
  }

  function disconnectWallet() {
    state.wallet = null;
    state.lastMintedIds = [];
    render();
    announce("Demo wallet disconnected.");
  }

  function announce(msg) {
    var live = $("#live-region");
    if (live) live.textContent = msg;
  }

  function counters() {
    return {
      minted: state.freeMinted + state.paidMinted,
      freeLeft: DATA.freeSupply - state.freeMinted,
      paidLeft: DATA.paidSupply - state.paidMinted,
      remaining: (DATA.freeSupply - state.freeMinted) + (DATA.paidSupply - state.paidMinted),
      cap: DATA.cap
    };
  }

  function countersHtml() {
    var c = counters();
    return '<div class="counters" aria-label="Collection counters">' +
      '<div class="counter"><strong data-counter="minted">' + c.minted + '</strong><span>MINTED</span></div>' +
      '<div class="counter"><strong data-counter="remaining">' + c.remaining + '</strong><span>REMAINING</span></div>' +
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
      box.innerHTML = '<span class="demo-badge">DEMO</span>' +
        '<span aria-label="Connected demo address, truncated">' + esc(state.wallet.truncated) + "</span>" +
        '<button type="button" class="btn-ghost" id="disconnect-btn">Disconnect</button>';
      $("#disconnect-btn").addEventListener("click", disconnectWallet);
    } else {
      box.innerHTML = '<button type="button" class="btn-primary" id="connect-btn">Connect Demo Wallet</button>';
      $("#connect-btn").addEventListener("click", connectDemoWallet);
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
      "<p>The Mythora contract is deployed on BNB Smart Chain: <a href=\"https://bscscan.com/address/0x27Ba185e74b681c3e548D369C1B0792eD7D738a1\" target=\"_blank\" rel=\"noopener noreferrer\">0x27Ba185e74b681c3e548D369C1B0792eD7D738a1</a>. Minting stays off until the owner activates it; the Mint box on this site remains a simulation.</p></div>" +
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

  /* ---------------- Mint ---------------- */
  function pickMintCandidates(count) {
    var avail = DATA.tokens.filter(function (t) {
      return t.status === "Available";
    });
    for (var i = avail.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = avail[i]; avail[i] = avail[j]; avail[j] = tmp;
    }
    return avail.slice(0, count);
  }

  /* Price by mint order: the first half of the collection (1,905) costs
   * 0.00005 BNB each, the second half costs 0.0005 BNB each. */
  function mintTotal(qty) {
    var minted = counters().minted;
    var cheap = Math.max(0, Math.min(qty, DATA.freeSupply - minted));
    var rest = qty - cheap;
    return cheap * DATA.freeMintFee + rest * DATA.paidMintPrice;
  }

  function fmtBnb(n) {
    return String(parseFloat(n.toFixed(5)));
  }

  /* No reveal step: the minter gets the actual card right away, directly
   * on this page. No question-mark card, no waiting, no dialog. */
  function mintedCardsHtml() {
    if (!state.lastMintedIds.length) return "";
    var cards = state.lastMintedIds.map(function (id) { return tokenCard(tokensById[id]); }).join("");
    return '<section class="card" id="your-cards" aria-labelledby="your-cards-h"><h3 id="your-cards-h">Your card' + (state.lastMintedIds.length > 1 ? "s" : "") + "</h3>" +
      "<p>You got your card right away &mdash; no question-mark card, no waiting. Pre-launch review &mdash; simulation, no real transaction, no BNB moves.</p>" +
      '<div class="grid-3">' + cards + "</div></section>";
  }

  function mintView() {
    var c = counters();
    var connected = !!state.wallet;
    if (state.mintQty > c.remaining) state.mintQty = Math.max(1, c.remaining);
    var notice = '<p class="notice">Pre-launch review &mdash; simulation, no real transaction, no BNB moves.</p>';
    var walletNote = "";
    if (!connected) {
      walletNote = '<p class="notice">Connect the demo wallet to use the simulation. No real wallet is used here.</p>';
    }
    var totalsLine = '<p class="mint-totals" aria-label="Total item, sudah mint, dan sisa"><strong>Total Item:</strong> ' + DATA.cap + ' &nbsp;&middot;&nbsp; <strong>Sudah Mint:</strong> ' + c.minted + ' &nbsp;&middot;&nbsp; <strong>Sisa:</strong> ' + c.remaining + "</p>";
    var oddsRows = DATA.rarity.map(function (r) {
      return "<tr><td>" + esc(r.name) + "</td><td>" + r.count + "</td><td>" + r.share + "</td></tr>";
    }).join("");
    var mintPanel = '<div id="panel-mint">' +
      "<h3>Mint</h3>" +
      '<div class="qty-row"><label for="mint-qty-label">Quantity</label>' +
      '<button type="button" id="qty-minus" aria-label="Decrease quantity" ' + ((!connected || state.mintQty <= 1) ? "disabled" : "") + ">&minus;</button>" +
      '<output id="mint-qty-label" aria-live="polite">' + state.mintQty + "</output>" +
      '<button type="button" id="qty-plus" aria-label="Increase quantity" ' + ((!connected || state.mintQty >= c.remaining) ? "disabled" : "") + ">+</button>" +
      "</div>" +
      '<button type="button" class="btn-primary" id="mint-btn" ' + ((!connected || c.remaining <= 0) ? "disabled" : "") + ">Simulate Mint &mdash; no real transaction</button>" +
      "</div>";
    return '<section aria-labelledby="mint-h"><h2 id="mint-h">Mint Portal</h2>' +
      "<p>You get your card right away. No question-mark card, no waiting.</p>" +
      notice + walletNote + totalsLine + mintedCardsHtml() +
      '<div class="card" id="mint-box">' + mintPanel + "</div>" +
      '<div class="card odds"><h3>Your odds on every mint</h3>' +
      "<p>Odds below are the collection counts. The draw is random in this simulation, and every remaining card &mdash; Legendary included &mdash; can be drawn.</p>" +
      "<table><thead><tr><th>Tier</th><th>Count</th><th>Share</th></tr></thead><tbody>" + oddsRows + "</tbody></table></div>" +
      '<p><a href="#/gallery">Browse the codex</a> &middot; <a href="#/transparency">Read the mint rules</a></p></section>';
  }

  function bindMint() {
    var minus = $("#qty-minus");
    var plus = $("#qty-plus");
    if (minus) minus.addEventListener("click", function () {
      if (state.mintQty > 1) { state.mintQty--; render(); }
    });
    if (plus) plus.addEventListener("click", function () {
      if (state.mintQty < counters().remaining) { state.mintQty++; render(); }
    });
    var mintBtn = $("#mint-btn");
    if (mintBtn) mintBtn.addEventListener("click", function () { doMint(state.mintQty); });
  }

  function doMint(qty) {
    if (!state.wallet) {
      announce("Connect the demo wallet first. Simulation only.");
      return;
    }
    var picked = pickMintCandidates(qty);
    if (picked.length < qty) {
      announce("Not enough tokens left for this simulation.");
      return;
    }
    picked.forEach(function (t) {
      t.status = "Minted";
      t.owner = state.wallet.truncated;
      t.mintedAt = "Demo session (simulation)";
      state.sessionMintedIds.push(t.id);
      if (t.pool === "free") state.freeMinted++;
      else state.paidMinted++;
    });
    state.lastMintedIds = picked.map(function (t) { return t.id; });
    render();
    announce("Minted " + picked.length + " token(s) in simulation. Counters updated.");
  }

  function galleryView(query, isNavigation) {
    if (isNavigation) {
      // Arriving via a link resets the filters; a rarity query applies it.
      // Re-renders caused by state changes (e.g. connecting the demo
      // wallet) preserve the filters the user already chose.
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
      "<dt>Owner</dt><dd>" + (t.owner ? esc(t.owner) + ' <span class="demo-badge">DEMO</span>' : "—") + "</dd>" +
            "<dt>Minted</dt><dd>" + esc(t.mintedAt || (t.preMinted ? "Before this reconstruction session (date not verified)" : "—")) + "</dd></dl>" +
      (t.status === "Available"
        ? '<p><a class="button btn-primary" href="#/mint">Mint in simulation</a></p>'
        : "") +
      '<p><a href="https://x.com/intent/post?text=' + encodeURIComponent("Mythora #" + t.id + " — " + t.name + " from the Mythora collection.") + '" target="_blank" rel="noopener noreferrer">Share on X</a></p>' +
      "</div></div></section>";
  }

  /* ---------------- Transparency ---------------- */
  function transparencyView() {
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
      "<p>One Mint flow for the whole collection: 3,810 tokens, no per-wallet limit in this reconstruction, per the owner&apos;s decision. Cards are drawn at random, including the Legendary cards. No mystery box: the card you get is picked at random from the unminted allocation at mint, with artwork, traits and edition shown right away.</p>" +
      "<p>Price follows the owner&apos;s rule: the first 1,905 tokens minted cost 0.00005 BNB each, and the remaining 1,905 cost 0.0005 BNB each. The displayed contract design described per-wallet limits; those limits are not applied here, and the contract design must be changed and re-checked before any real deploy if the no-limit rule is to stand.</p></div>" +
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
      "<dt>Total minted</dt><dd>0</dd>" +
      "<dt>Minting</dt><dd>Off (mintActive is false)</dd>" +
      "<dt>Royalty</dt><dd>5% to the payout wallet (EIP-2981)</dd>" +
      "<dt>Verified on-chain</dt><dd>22:03 WIB, 29 Oct 2026. The deployed bytecode matches the verified contract draft.</dd></dl>" +
      "<p>No audit report or auditor name is claimed here: no independent audit exists. The full art set and metadata are pinned to IPFS (root CID <span class=\"address\">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span>); view them via the <a href=\"https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1\">Filebase gateway</a>. The contract baseURI is not yet set on-chain: the owner still needs to call setBaseURI. The BscScan link above points to the real deployed contract.</p></div>" +
      '<div class="card"><h3>Displayed contract, summarised in plain words</h3>' +
      "<p>The code shown on the preview Transparency page (summarised here, not reproduced) used fixed constants for the 3,810 cap, the two 1,905 pools, the 0.00005 BNB free fee, the 0.0005 BNB paid price, and the per-wallet limits of 2 free and 10 paid. It named mint operations for the free pool (one token per call) and the paid pool (one to five per call), owner-only controls to switch minting on, change the metadata base address, and change the payout wallet, a safety withdrawal that always sends any stray balance to the payout wallet, and royalty handling. Minting was described as starting switched off, with a reentrancy guard on the mint operations and revenue forwarded in the same transaction.</p>" +
      "<p>What was not in the displayed design: no allowlist or phase logic, no on-chain randomness, and no on-chain enforcement of which rarity or pool a given token id belongs to &mdash; token ids ran in mint order, so rarity and pool mapping depended on off-chain metadata. The owner could also change the metadata base address and the payout wallet at any time in the displayed design, with no freeze or timelock shown.</p></div>" +
      '<div class="warning" role="note"><h3>Under review</h3>' +
      "<p><strong>Voting functions were not present in the displayed contract.</strong> Voting is simulation only in this reconstruction. That claim is under review and must not be presented as a live contract feature. A decision is still needed for voting: remove the claim, postpone it, or build it separately. There is no Fusion feature: it was removed at the owner's request, and the revised contract draft has no fusion or burn functions.</p></div>" +
      '<div class="card"><h3>Launch checklist</h3><ol>' +
      "<li>Final creator review of this page and the allocation table.</li>" +
      "<li><strong>Done:</strong> deployed to BNB Smart Chain on 29 Oct 2026 (no testnet rehearsal, per the owner&apos;s decision) and verified on-chain.</li>" +
      "<li><strong>Done:</strong> full art set + metadata pinned to IPFS on 29 Oct 2026. Root CID <span class=\"address\">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span> (<a href=\"https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1\">gateway</a>). The contract baseURI is not yet set on-chain; the owner still needs to call setBaseURI, then setMintActive.</li>" +
      "<li>Verify the contract source on BscScan.</li>" +
      "<li>Owner calls setMintActive &mdash; the drop is live. Minting stays off until then.</li>" +
      "</ol><p>The contract is deployed, but minting stays off until the owner completes the remaining steps. No independent audit exists.</p></div>" +
      '<div class="card"><h3>Metadata standard</h3><p>Every token exposes standard ERC-721 metadata JSON &mdash; name, description, image and attributes. The full set is pinned to IPFS at root CID <span class="address">bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u</span> (gateway: <a href="https://ipfs.filebase.io/ipfs/bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/1">metadata/1</a>). The intended baseURI is <span class="address">ipfs://bafybeiguw4oszrazrivejadkkawx7l7iaff2g2dbgioim27fayvsxiwe6u/metadata/</span>, but it is not yet set on-chain: the owner still needs to call setBaseURI.</p></div></section>';
  }

  /* ---------------- Governance ---------------- */
  function governanceView() {
    var holds = state.sessionMintedIds.length > 0;
    var controls;
    if (!state.wallet) {
      controls = '<div class="callout"><p><strong>Hold a Mythora to vote.</strong></p>' +
        '<p>Connect the demo wallet to see the simulated voting controls. No Vote button is shown until a demo wallet is connected.</p>' +
        '<button type="button" class="btn-primary" id="gov-connect">Connect Demo Wallet</button></div>';
    } else if (!holds) {
      controls = '<div class="callout"><p><strong>Hold a Mythora to vote.</strong></p>' +
        '<p>This demo wallet holds no Mythora token in this session yet.</p>' +
        '<p><a class="button btn-primary" href="#/mint">Mint your first guardian (simulation)</a></p></div>';
    } else {
      controls = '<div class="callout"><p><strong>Your voting power: 1</strong> &mdash; one wallet, one vote (simulation). Your session holding: ' + state.sessionMintedIds.length + ' token(s).</p>' +
        "<p>Voting switches your single vote between proposals. This state is session-only and is not tied to a real wallet or contract.</p></div>";
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
    if (connectBtn) connectBtn.addEventListener("click", connectDemoWallet);
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
  }

  window.addEventListener("hashchange", render);

  // Exposed only for local verification of this reconstruction.
  window.MYTHORA_TEST = { state: state, data: DATA, counters: counters, tokensById: tokensById };

  render();
})();
