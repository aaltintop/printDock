(function () {
  "use strict";

  if (window.__printdockCartFeeUiInit) return;
  window.__printdockCartFeeUiInit = true;
  window.__printdockCartFeeUiLoaded = true;

  const nativeFetch =
    typeof window.fetch === "function"
      ? window.fetch.bind(window)
      : null;

  const DEBUG =
    typeof localStorage !== "undefined" && localStorage.getItem("printdock_debug") === "1";

  const HEAL_ATTEMPTED = new Set();
  let syncInFlight = false;
  let enhanceScheduled = false;

  function debugLog(event, payload) {
    if (!DEBUG) return;
    if (payload !== undefined) {
      console.info("[PrintDock Cart]", event, payload);
    } else {
      console.info("[PrintDock Cart]", event);
    }
  }

  function linePropertiesObject(rawProps) {
    if (!rawProps) return {};
    if (Array.isArray(rawProps)) {
      const out = {};
      rawProps.forEach((entry) => {
        if (entry && entry.name != null) out[String(entry.name)] = String(entry.value ?? "");
      });
      return out;
    }
    if (typeof rawProps === "object") {
      const out = {};
      Object.entries(rawProps).forEach(([key, value]) => {
        out[String(key)] = String(value ?? "");
      });
      return out;
    }
    return {};
  }

  function parsePriceMapJson(raw) {
    try {
      const parsed = JSON.parse(String(raw || ""));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => ({
          sid: String(entry?.sid || "").trim(),
          token: String(entry?.token || "").trim(),
        }))
        .filter((entry) => entry.sid && entry.token);
    } catch (_err) {
      return [];
    }
  }

  function readJwtMode(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    try {
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const payload = JSON.parse(window.atob(padded));
      const mode = String(payload?.mode || "").trim();
      return mode === "buildB" || mode === "legacy" ? mode : null;
    } catch (_err) {
      return null;
    }
  }

  function wrapCartLine(item, index) {
    return {
      item,
      index,
      lineNumber: index + 1,
    };
  }

  function buildPairs(items) {
    const artworkBySession = new Map();
    const feeBySession = new Map();

    (items || []).forEach((item, index) => {
      const props = linePropertiesObject(item.properties);
      const session = String(props._uc_session || "").trim();
      const feeFor = String(props._pd_fee_for || "").trim();
      if (session) artworkBySession.set(session, wrapCartLine(item, index));
      if (feeFor) feeBySession.set(feeFor, wrapCartLine(item, index));
    });

    const pairs = [];
    const sessions = new Set([...artworkBySession.keys(), ...feeBySession.keys()]);
    sessions.forEach((sid) => {
      pairs.push({
        sid,
        artwork: artworkBySession.get(sid) || null,
        fee: feeBySession.get(sid) || null,
      });
    });
    return pairs;
  }

  function escapeAttrValue(value) {
    const s = String(value || "");
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(s);
    }
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function formatMoney(cents, currency) {
    if (typeof window.Shopify !== "undefined" && typeof window.Shopify.formatMoney === "function") {
      return window.Shopify.formatMoney(cents);
    }
    const amount = (Number(cents) / 100).toFixed(2);
    return `${currency || ""} ${amount}`.trim();
  }

  function isMainCartPage() {
    try {
      const path = window.location.pathname.replace(/\/+$/, "") || "/";
      return path === "/cart" || path.endsWith("/cart");
    } catch (_err) {
      return false;
    }
  }

  function isDrawerVisible() {
    const drawer = document.querySelector("cart-drawer");
    if (!drawer) return false;
    return drawer.classList.contains("active") || drawer.classList.contains("animate");
  }

  /** Cart DOM roots to search — avoids merging hidden drawer rows while on /cart. */
  function getCartLineContainers() {
    const containers = [];

    if (isMainCartPage()) {
      const main = document.getElementById("main-cart-items");
      if (main) containers.push(main);
      document.querySelectorAll("cart-items").forEach((el) => {
        if (main && (main === el || main.contains(el))) return;
        if (!el.closest("cart-drawer")) containers.push(el);
      });
    }

    if (!isMainCartPage() || isDrawerVisible()) {
      const drawerItems = document.querySelector("cart-drawer-items");
      if (drawerItems) containers.push(drawerItems);
    }

    if (containers.length === 0) {
      const fallback =
        document.querySelector("cart-drawer-items") ||
        document.getElementById("main-cart-items") ||
        document.querySelector("cart-items");
      if (fallback) containers.push(fallback);
    }

    return containers;
  }

  function queryInContainers(containers, selector) {
    for (let i = 0; i < containers.length; i += 1) {
      const hit = containers[i].querySelector(selector);
      if (hit) return hit;
    }
    return null;
  }

  function listCartRowsInContainers(containers) {
    const rows = [];
    containers.forEach((root) => {
      root.querySelectorAll(
        ".cart-item, tr.cart-item, [id^='CartItem-'], [id^='CartDrawer-Item-']",
      ).forEach((row) => {
        if (!rows.includes(row)) rows.push(row);
      });
    });
    return rows;
  }

  /**
   * Dawn uses 1-based ids: `#CartDrawer-Item-N` (drawer) and `#CartItem-N` (/cart page).
   * On /cart, prefer main-cart rows only — the drawer is still in the DOM but hidden.
   */
  function findRowForCartLine(lineRef) {
    if (!lineRef || !lineRef.item) return null;
    const item = lineRef.item;
    const lineNumber = lineRef.lineNumber;
    const containers = getCartLineContainers();

    if (lineNumber > 0) {
      if (isMainCartPage()) {
        const mainRow =
          document.getElementById(`CartItem-${lineNumber}`) ||
          queryInContainers(containers, `#CartItem-${lineNumber}`);
        if (mainRow) return mainRow;
      } else {
        const drawerRow =
          document.getElementById(`CartDrawer-Item-${lineNumber}`) ||
          queryInContainers(containers, `#CartDrawer-Item-${lineNumber}`);
        if (drawerRow) return drawerRow;
      }

      const fallback =
        document.getElementById(`CartItem-${lineNumber}`) ||
        document.getElementById(`CartDrawer-Item-${lineNumber}`);
      if (fallback) return fallback;
    }

    const lineKey = String(item.key || "").trim();
    if (lineKey) {
      const byKey = queryInContainers(containers, `[data-key="${escapeAttrValue(lineKey)}"]`);
      if (byKey) return byKey;
    }

    const variantId = String(item.variant_id || "").trim();
    if (variantId) {
      const qtyInput = queryInContainers(
        containers,
        `[data-quantity-variant-id="${variantId}"]`,
      );
      if (qtyInput) {
        return (
          qtyInput.closest(".cart-item") ||
          qtyInput.closest("tr.cart-item") ||
          qtyInput.closest("[id^='CartDrawer-Item']") ||
          qtyInput.closest("[id^='CartItem']")
        );
      }
    }

    const rows = listCartRowsInContainers(containers);
    if (lineRef.index >= 0 && lineRef.index < rows.length) {
      return rows[lineRef.index];
    }

    return null;
  }

  function countMissingRowDom(pairs) {
    let missing = 0;
    pairs.forEach((pair) => {
      if (!pair.artwork || !pair.fee) return;
      if (!findRowForCartLine(pair.artwork)) missing += 1;
      if (!findRowForCartLine(pair.fee)) missing += 1;
    });
    return missing;
  }

  function resetEnhancementMarkers() {
    document.querySelectorAll("[data-printdock-merged]").forEach((el) => {
      el.removeAttribute("data-printdock-merged");
    });
    document.querySelectorAll(".printdock-fee-disclosure").forEach((el) => el.remove());
    document.querySelectorAll(".printdock-fee-line--hidden").forEach((el) => {
      el.classList.remove("printdock-fee-line--hidden");
      el.removeAttribute("aria-hidden");
    });
    document.querySelectorAll(".printdock-fee-qty-hidden").forEach((el) => {
      el.classList.remove("printdock-fee-qty-hidden");
      el.style.removeProperty("display");
    });
  }

  function enhanceCartDrawer(cart) {
    if (!cart || !Array.isArray(cart.items)) return 0;
    resetEnhancementMarkers();

    const pairs = buildPairs(cart.items).filter((pair) => pair.artwork && pair.fee);
    let merged = 0;

    pairs.forEach((pair) => {
      const artworkRow = findRowForCartLine(pair.artwork);
      const feeRow = findRowForCartLine(pair.fee);
      if (!artworkRow || !feeRow) {
        debugLog("merge_skip_missing_row", {
          sid: pair.sid,
          artworkLine: pair.artwork?.lineNumber,
          feeLine: pair.fee?.lineNumber,
          hasArtworkRow: Boolean(artworkRow),
          hasFeeRow: Boolean(feeRow),
        });
        return;
      }

      const combinedCents =
        Number(pair.artwork.item.final_line_price ?? pair.artwork.item.line_price ?? 0) +
        Number(pair.fee.item.final_line_price ?? pair.fee.item.line_price ?? 0);
      const feeCents = Number(pair.fee.item.final_line_price ?? pair.fee.item.line_price ?? 0);

      const priceEl =
        artworkRow.querySelector(".cart-item__totals .price") ||
        artworkRow.querySelector(".cart-item__price-wrapper .price") ||
        artworkRow.querySelector(".cart-item__price .price") ||
        artworkRow.querySelector(".cart-item__price") ||
        artworkRow.querySelector(".price") ||
        artworkRow.querySelector("[class*='price']");
      if (priceEl) {
        priceEl.textContent = formatMoney(combinedCents, cart.currency);
        priceEl.classList.add("printdock-merged-price");
      }

      const disclosure = document.createElement("p");
      disclosure.className = "printdock-fee-disclosure";
      disclosure.setAttribute("data-printdock-disclosure", pair.sid);
      disclosure.textContent = `Includes ${formatMoney(feeCents, cart.currency)} artwork upload fee`;

      const anchor =
        artworkRow.querySelector(".cart-item__details") ||
        artworkRow.querySelector(".product-option")?.parentElement ||
        artworkRow.querySelector(".cart-item__name")?.parentElement ||
        artworkRow;
      anchor.appendChild(disclosure);

      if (document.body.contains(disclosure)) {
        feeRow.classList.add("printdock-fee-line--hidden");
        feeRow.setAttribute("aria-hidden", "true");
        artworkRow.setAttribute("data-printdock-merged", pair.sid);

        const feeQty = feeRow.querySelector("quantity-input, .quantity, .cart-item__quantity");
        if (feeQty) {
          feeQty.classList.add("printdock-fee-qty-hidden");
          feeQty.style.display = "none";
        }
        merged += 1;
      }
    });

    debugLog("merge_complete", { pairCount: pairs.length, mergedCount: merged });
    return merged;
  }

  const RETRY_DELAYS_MS = [0, 100, 250, 500, 900, 1400];

  function scheduleEnhance(cart, attempt) {
    const tryNum = typeof attempt === "number" ? attempt : 0;
    if (tryNum === 0) {
      if (enhanceScheduled) return;
      enhanceScheduled = true;
    }

    const delay = RETRY_DELAYS_MS[Math.min(tryNum, RETRY_DELAYS_MS.length - 1)];

    window.setTimeout(() => {
      if (tryNum === 0) enhanceScheduled = false;

      const run = (activeCart) => {
        if (!activeCart) return;
        const pairs = buildPairs(activeCart.items).filter((p) => p.artwork && p.fee);
        const merged = enhanceCartDrawer(activeCart);
        const missingDom = countMissingRowDom(pairs);

        if (pairs.length > 0 && (merged === 0 || missingDom > 0) && tryNum + 1 < RETRY_DELAYS_MS.length) {
          if (tryNum + 1 === 1 || missingDom > 0) {
            void fetchCart().then((fresh) => {
              if (fresh) scheduleEnhance(fresh, tryNum + 1);
            });
          } else {
            scheduleEnhance(activeCart, tryNum + 1);
          }
        }
      };

      try {
        if (cart) {
          run(cart);
        } else {
          void fetchCart().then(run);
        }
      } catch (_err) {
        debugLog("merge_error", { message: String(_err && _err.message ? _err.message : _err) });
      }
    }, delay);
  }

  async function fetchCart() {
    if (!nativeFetch) return null;
    const res = await nativeFetch("/cart.js", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchCartAndEnhance() {
    const cart = await fetchCart();
    if (cart) scheduleEnhance(cart, 0);
    return cart;
  }

  async function applyCartUpdates(updates) {
    if (!nativeFetch || !updates || Object.keys(updates).length === 0) return;
    await nativeFetch("/cart/update.js", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ updates }),
    });
  }

  async function syncPairedLines(cart) {
    if (!cart || syncInFlight) return cart;
    syncInFlight = true;
    try {
      const updates = {};
      const pairs = buildPairs(cart.items);

      pairs.forEach((pair) => {
        if (
          pair.artwork &&
          pair.fee &&
          pair.artwork.item.quantity !== pair.fee.item.quantity
        ) {
          updates[pair.fee.item.key] = pair.artwork.item.quantity;
        }
      });

      const priceMap = parsePriceMapJson(
        cart.attributes?._pd_price_map || cart.attributes?.__pd_price_map,
      );
      const feeVariantId = String(cart.attributes?._pd_fee_variant_id || "").trim();

      for (const entry of priceMap) {
        if (readJwtMode(entry.token) !== "buildB") continue;
        const hasArtwork = pairs.some((p) => p.sid === entry.sid && p.artwork);
        const hasFee = pairs.some((p) => p.sid === entry.sid && p.fee);
        if (hasArtwork && !hasFee && feeVariantId && !HEAL_ATTEMPTED.has(entry.sid)) {
          HEAL_ATTEMPTED.add(entry.sid);
          const artwork = pairs.find((p) => p.sid === entry.sid)?.artwork;
          await nativeFetch("/cart/add.js", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              items: [
                {
                  id: Number(feeVariantId),
                  quantity: artwork?.item?.quantity || 1,
                  properties: { _pd_fee_for: entry.sid },
                },
              ],
            }),
          });
          return await fetchCart();
        }
      }

      if (Object.keys(updates).length > 0) {
        await applyCartUpdates(updates);
        return await fetchCart();
      }
    } finally {
      syncInFlight = false;
    }
    return cart;
  }

  async function afterCartMutation() {
    try {
      let cart = await fetchCart();
      if (!cart) return;
      cart = await syncPairedLines(cart);
      scheduleEnhance(cart, 0);
    } catch (_err) {
      debugLog("after_cart_mutation_error", String(_err && _err.message ? _err.message : _err));
    }
  }

  function getSameOriginStorePathname(url) {
    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.origin !== window.location.origin) return null;
      return parsed.pathname.replace(/\/+$/, "") || "";
    } catch (_err) {
      return null;
    }
  }

  function isCartMutationRequest(url, method) {
    if ((method || "GET").toUpperCase() !== "POST") return false;
    const path = getSameOriginStorePathname(url);
    if (!path) return false;
    return (
      path.endsWith("/cart/change") ||
      path.endsWith("/cart/change.js") ||
      path.endsWith("/cart/update") ||
      path.endsWith("/cart/update.js") ||
      path.endsWith("/cart/add") ||
      path.endsWith("/cart/add.js")
    );
  }

  function patchFetch() {
    if (!nativeFetch || window.__printdockCartFeeFetchPatched) return;
    window.__printdockCartFeeFetchPatched = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input?.url || "";
      const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
      let response;
      try {
        response = await originalFetch(input, init);
      } catch (err) {
        throw err;
      }
      try {
        if (isCartMutationRequest(requestUrl, method) && response.ok) {
          void afterCartMutation();
        }
      } catch (_err) {
        /* passthrough */
      }
      return response;
    };
  }

  function hookThemePubSub() {
    try {
      if (typeof subscribe !== "function" || typeof PUB_SUB_EVENTS === "undefined") return;
      subscribe(PUB_SUB_EVENTS.cartUpdate, (event) => {
        const cartData = event && event.cartData;
        if (!cartData || !Array.isArray(cartData.items)) return;
        debugLog("theme_cart_update", { itemCount: cartData.items.length, source: event.source });
        scheduleEnhance(
          {
            items: cartData.items,
            currency: cartData.currency,
            attributes: cartData.attributes,
          },
          0,
        );
      });
    } catch (_err) {
      debugLog("pubsub_hook_failed", String(_err && _err.message ? _err.message : _err));
    }
  }

  function observeCartDom() {
    const targets = [
      document.getElementById("main-cart-items"),
      document.querySelector("cart-drawer"),
      document.querySelector("#CartDrawer"),
      document.querySelector("cart-drawer-items"),
      document.querySelector("cart-items"),
      document.body,
    ].filter(Boolean);
    if (targets.length === 0) return;
    const observer = new MutationObserver(() => {
      void fetchCartAndEnhance();
    });
    targets.forEach((target) => {
      observer.observe(target, { childList: true, subtree: true });
    });

    const drawer = document.querySelector("cart-drawer");
    if (drawer) {
      const drawerObserver = new MutationObserver(() => {
        if (drawer.classList.contains("active") || drawer.classList.contains("animate")) {
          void fetchCartAndEnhance();
        }
      });
      drawerObserver.observe(drawer, { attributes: true, attributeFilter: ["class"] });
    }
  }

  function init() {
    patchFetch();
    hookThemePubSub();
    observeCartDom();
    document.addEventListener("cart:updated", () => void afterCartMutation());
    void afterCartMutation();
    debugLog("init", { loaded: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
