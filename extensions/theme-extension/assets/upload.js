(function () {
  "use strict";

  const root = document.getElementById("printdock-upload-root");
  if (!root) return;

  const PRODUCT_ID = root.dataset.productId;
  const BASE_VARIANT_PRICE = Number(root.dataset.variantPrice || "0");
  const BLOCK_REQUIRED = root.dataset.required === "true";
  const SESSION_STORAGE_KEY = `printdock_session_${PRODUCT_ID}`;
  const SESSION_EXPIRES_STORAGE_KEY = `${SESSION_STORAGE_KEY}_expires`;
  const PROXY_URL = "/apps/printdock"; // Configured in shopify.app.toml

  // Merchant-configurable copy (theme block settings → data-* attributes on root).
  const LABELS = {
    dropHeadline: root.dataset.dropHeadline || "Drop your artwork here",
    chooseLabel: root.dataset.chooseLabel || "Choose file",
    checkingLabel: root.dataset.checkingLabel || "Checking file...",
    priceLabel: root.dataset.priceLabel || "Calculated upload price:",
  };

  const DEFAULT_CONFIG = {
    id: null,
    isRequired: BLOCK_REQUIRED,
    storefrontTitle: "Upload your artwork",
    storefrontDescription: "Supported files: PNG, JPG, JPEG, PDF",
    allowedExtensions: ["png", "jpg", "jpeg", "pdf"],
    maxFileMB: 50,
    minFiles: 1,
    maxFiles: 1,
    fileQuantityManagement: {
      enabled: false,
      mode: "product_quantity",
    },
  };

  let fieldConfig = { ...DEFAULT_CONFIG };
  let billingPlan = null;
  let isRequired = BLOCK_REQUIRED;
  let sessionToken = localStorage.getItem(SESSION_STORAGE_KEY) || null;
  let sessionExpiresAt = localStorage.getItem(SESSION_EXPIRES_STORAGE_KEY) || null;
  if (sessionExpiresAt) {
    const ts = Date.parse(sessionExpiresAt);
    if (!Number.isNaN(ts) && ts <= Date.now()) {
      clearStoredSession();
    }
  }
  let uploadedFiles = [];
  let isUploading = false;
  let isBlocked = false;
  const boundForms = new WeakSet();
  let formObserver = null;

  function clearStoredSession() {
    sessionToken = null;
    sessionExpiresAt = null;
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(SESSION_EXPIRES_STORAGE_KEY);
    } catch (_) {}
  }

  async function fetchUploadSession(file, tokenToUse) {
    const res = await fetch(`${PROXY_URL}/api/proxy/upload/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: PRODUCT_ID,
        variantId: root.dataset.variantId || "",
        fieldId: fieldConfig.id || "",
        sessionToken: tokenToUse || undefined,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Failed to get upload session (${res.status}): invalid response`);
    }
    return { ok: res.ok, status: res.status, json, text };
  }

  function isStaleSessionError(status, json) {
    if (status !== 400) return false;
    const msg = String(json?.error || "").toLowerCase();
    return (
      msg.includes("maximum file count reached") ||
      msg.includes("session product mismatch")
    );
  }

  // ─── INIT ────────────────────────────────────────────────────────────
  async function init() {
    await loadFieldConfig();
    // No field targets this product (or collection) — hide the block entirely.
    if (!fieldConfig.id) {
      root.innerHTML = "";
      root.style.display = "none";
      root.setAttribute("aria-hidden", "true");
      return;
    }
    // Cart/uploads state is not rehydrated from the server on reload, so any stored
    // session token is effectively orphaned — drop it so the next upload starts fresh.
    if (uploadedFiles.length === 0 && sessionToken) {
      clearStoredSession();
    }
    renderUI();
    setupAddToCartGuard();
    setupCartAddFetchInterceptor();
    setupCartAddXHRInterceptor();
    setupProductQuantityListener();
    updateCartState();
  }

  // Keep the calculated-price display in sync when the shopper changes the
  // product quantity input on the page (dynamic pricing scales by line qty).
  function setupProductQuantityListener() {
    const form = document.querySelector('form[action*="/cart/add"]');
    if (!form) return;
    const quantityInput = form.querySelector('input[name="quantity"]');
    if (!quantityInput) return;
    const handler = () => updatePriceDisplay();
    quantityInput.addEventListener("input", handler);
    quantityInput.addEventListener("change", handler);
  }

  async function loadFieldConfig() {
    const variantId = root.dataset.variantId || "";
    const configUrl = `${PROXY_URL}/api/proxy/upload/config?productId=${encodeURIComponent(
      PRODUCT_ID,
    )}&variantId=${encodeURIComponent(variantId)}`;

    try {
      const res = await fetch(configUrl);
      if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
      const payload = await res.json();
      billingPlan = payload.billingPlan || null;
      if (payload.field) {
        fieldConfig = Object.assign({}, DEFAULT_CONFIG, payload.field);
      }
    } catch (error) {
      console.error("PrintDock config fetch error:", error);
      fieldConfig = { ...DEFAULT_CONFIG };
    }

    // If no field is configured, don't block checkout by default.
    isRequired = Boolean(fieldConfig.id) && Boolean(fieldConfig.isRequired);
  }

  // ─── FILE UPLOAD ──────────────────────────────────────────────────────
  async function handleFiles(files) {
    if (files.length === 0) return;
    const slotsLeft = Math.max(fieldConfig.maxFiles - uploadedFiles.length, 0);
    if (slotsLeft <= 0) {
      showError(`Maximum file count reached (${fieldConfig.maxFiles}).`);
      return;
    }
    const selectedFiles = files.slice(0, slotsLeft);

    if (isUploading) {
      showError("Please wait until current upload finishes.");
      return;
    }

    isUploading = true;
    for (const selected of selectedFiles) {
      if (!isValidExtension(selected.name)) {
        showError(
          `File type not allowed. Supported: ${fieldConfig.allowedExtensions.join(", ").toUpperCase()}`,
        );
        continue;
      }

      const maxBytes = fieldConfig.maxFileMB * 1024 * 1024;
      if (selected.size > maxBytes) {
        showError(`File is too large. Max size is ${fieldConfig.maxFileMB}MB.`);
        continue;
      }
      await uploadFile(selected);
    }
    isUploading = false;
  }

  function isValidExtension(fileName) {
    const ext = fileName.split(".").pop();
    if (!ext) return false;
    return fieldConfig.allowedExtensions.includes(ext.toLowerCase());
  }

  function inputAccept() {
    return fieldConfig.allowedExtensions.map((ext) => `.${ext}`).join(",");
  }

  async function uploadFile(file) {
    const fileEntry = {
      id: Math.random().toString(36).slice(2),
      name: file.name,
      size: file.size,
      previewUrl: file.type && file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      status: "uploading",
      progress: 0,
      metadata: null,
      pricing: null,
      validationResults: [],
      blocked: false,
      quantity: defaultFileQuantity(),
      storagePath: null,
      printReadyFileUrl: null,
    };

    uploadedFiles.push(fileEntry);
    renderFileList();
    updateCartState();

    try {
      // Step 1: Get presigned URL from our App Proxy (auto-retry once without a stale token).
      let sessionResult = await fetchUploadSession(file, sessionToken);
      if (!sessionResult.ok && sessionToken && isStaleSessionError(sessionResult.status, sessionResult.json)) {
        clearStoredSession();
        sessionResult = await fetchUploadSession(file, null);
      }
      if (!sessionResult.ok) {
        if (
          sessionResult.status === 402 &&
          sessionResult.json?.error === "storage_cap_exceeded"
        ) {
          console.warn("PrintDock storage cap hit", sessionResult.json);
          showError(
            "This shop has reached its upload storage limit. Please contact the merchant to free space or upgrade the plan.",
          );
          fileEntry.status = "error";
          fileEntry.error = "Storage limit reached.";
          renderFileList();
          updateCartState();
          updatePriceDisplay();
          return;
        }
        const hint =
          sessionResult.json?.detail ||
          sessionResult.json?.error ||
          sessionResult.text.slice(0, 200);
        throw new Error(`Failed to get upload session (${sessionResult.status}): ${hint}`);
      }
      const sessionData = sessionResult.json;
      sessionToken = sessionData.sessionToken;
      sessionExpiresAt = sessionData.expiresAt || null;
      localStorage.setItem(SESSION_STORAGE_KEY, sessionToken);
      if (sessionExpiresAt) {
        localStorage.setItem(SESSION_EXPIRES_STORAGE_KEY, sessionExpiresAt);
      } else {
        localStorage.removeItem(SESSION_EXPIRES_STORAGE_KEY);
      }
      const { presignedUrl, storagePath } = sessionData;
      fileEntry.storagePath = storagePath;

      // Step 2: Upload directly to Firebase Storage
      await uploadToFirebase(file, presignedUrl, (progress) => {
        fileEntry.progress = progress;
        renderFileList();
      });

      // Step 3: Confirm upload to our server for validation + pricing
      fileEntry.status = "validating";
      renderFileList();

      const confirmRes = await fetch(`${PROXY_URL}/api/proxy/upload/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken,
          storagePath,
          originalName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          quantity: fileEntry.quantity || 1,
        }),
      });

      const confirmText = await confirmRes.text();
      let confirmData;
      try {
        confirmData = JSON.parse(confirmText);
      } catch {
        confirmData = null;
      }

      if (!confirmRes.ok) {
        if (confirmRes.status === 402 && confirmData?.error === "storage_cap_exceeded") {
          console.warn("PrintDock storage cap hit", confirmData);
          showError(
            "This shop has reached its upload storage limit. Please contact the merchant to free space or upgrade the plan.",
          );
          throw new Error("Storage limit reached.");
        }
        const serverMsg =
          confirmData?.error ||
          confirmData?.message ||
          confirmData?.detail ||
          `Upload failed (${confirmRes.status}). Please try again.`;
        showError(serverMsg);
        throw new Error(serverMsg);
      }

      fileEntry.status = confirmData.blocked ? "blocked" : "success";
      fileEntry.metadata = confirmData.metadata;
      fileEntry.pricing = confirmData.pricing;
      fileEntry.validationResults = confirmData.validationResults;
      fileEntry.blocked = confirmData.blocked;
      fileEntry.assetId = confirmData.asset?.id || null;
      fileEntry.printReadyFileUrl =
        !confirmData.blocked && confirmData.printReadyFileUrl
          ? confirmData.printReadyFileUrl
          : null;

    } catch (err) {
      fileEntry.status = "error";
      const msg = err instanceof Error ? err.message : String(err);
      fileEntry.error =
        msg.length > 180 ? `${msg.slice(0, 180)}…` : msg || "Upload failed. Please try again.";
      console.error("PrintDock upload error:", err);
    }

    renderFileList();
    updateCartState();
    updatePriceDisplay();
  }

  async function uploadToFirebase(file, presignedUrl, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", presignedUrl, true);
      xhr.setRequestHeader(
        "Content-Type",
        file.type && file.type.trim() !== "" ? file.type : "application/octet-stream",
      );

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };

      xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error(`Storage upload failed: ${xhr.status}`));
      xhr.onerror = () => reject(new Error("Storage upload network error"));
      xhr.send(file);
    });
  }

  // ─── CART MANAGEMENT ─────────────────────────────────────────────────
  function setupAddToCartGuard() {
    const bindForms = () => {
      const forms = document.querySelectorAll('form[action*="/cart/add"]');
      forms.forEach((form) => {
        if (boundForms.has(form)) return;
        boundForms.add(form);

        form.addEventListener("submit", (e) => {
          const validationError = getAddToCartValidationError();
          if (validationError) {
            e.preventDefault();
            showError(validationError);
            return;
          }
          injectCartProperties(form);
        });
      });
    };

    bindForms();
    if (formObserver) formObserver.disconnect();
    formObserver = new MutationObserver(bindForms);
    formObserver.observe(document.body, { childList: true, subtree: true });
  }

  function injectCartProperties(form) {
    const properties = getCartProperties();
    Object.entries(properties).forEach(([key, value]) => {
      setHiddenInput(form, `properties[${key}]`, value);
    });
  }

  function getAddToCartValidationError() {
    const successfulFiles = uploadedFiles.filter((entry) => entry.status === "success");
    if (isRequired && successfulFiles.length < Math.max(1, fieldConfig.minFiles)) {
      return `Please upload at least ${Math.max(1, fieldConfig.minFiles)} file(s) before adding to cart.`;
    }
    if (isBlocked) {
      return "Please fix the file issues before adding to cart.";
    }
    return null;
  }

  function getMerchantUploadsLink(sessionId) {
    const shopDomain = root.dataset.shopDomain || "";
    const appHandle = root.dataset.appHandle || "printdock";
    const encodedSession = encodeURIComponent(sessionId);
    if (shopDomain.endsWith(".myshopify.com")) {
      const storeHandle = shopDomain.replace(/\.myshopify\.com$/i, "");
      return `https://admin.shopify.com/store/${storeHandle}/apps/${appHandle}/app/uploads?session=${encodedSession}`;
    }
    return `/apps/${appHandle}/app/uploads?session=${encodedSession}`;
  }

  function getCartProperties() {
    const successfulFiles = uploadedFiles.filter((entry) => entry.status === "success");
    if (!sessionToken || successfulFiles.length === 0) return {};

    const properties = {
      _uc_session: sessionToken,
      "_View uploads": getMerchantUploadsLink(sessionToken),
      _Artwork: successfulFiles.map((entry) => entry.name).join(", "),
    };
    const printUrl = successfulFiles[0]?.printReadyFileUrl;
    if (printUrl) {
      properties["_Print Ready File"] = printUrl;
    }

    // `_pd_calculated_price` carries only the PER-UNIT dynamic upload fee.
    // The Cart Transform adds this fee on top of the variant base price and
    // applies the resulting per-unit total with `fixedPricePerUnit`.
    //
    // Each file contributes its per-unit `filePrice`; line quantity scales naturally.
    const unitPriceForLine = successfulFiles.reduce((sum, entry) => {
      if (!entry.pricing) return sum;
      const fileUnitPrice =
        entry.pricing.filePrice != null ? Number(entry.pricing.filePrice) : Number(entry.pricing.total);
      if (!Number.isFinite(fileUnitPrice) || fileUnitPrice <= 0) return sum;
      return sum + fileUnitPrice;
    }, 0);
    if (Number.isFinite(unitPriceForLine) && unitPriceForLine > 0) {
      properties._pd_calculated_price = unitPriceForLine.toFixed(2);
    }

    return properties;
  }

  function applyPropertiesToFormData(formData, properties) {
    Object.entries(properties).forEach(([key, value]) => {
      formData.set(`properties[${key}]`, value);
    });
    return formData;
  }

  function applyPropertiesToSearchParams(searchParams, properties) {
    Object.entries(properties).forEach(([key, value]) => {
      searchParams.set(`properties[${key}]`, value);
    });
    return searchParams;
  }

  function mergePropertiesIntoJsonPayload(payload, properties) {
    if (!payload || typeof payload !== "object") return payload;
    const clonedPayload = { ...payload };
    if (Array.isArray(clonedPayload.items)) {
      clonedPayload.items = clonedPayload.items.map((item) => ({
        ...item,
        properties: { ...(item?.properties || {}), ...properties },
      }));
      return clonedPayload;
    }
    clonedPayload.properties = { ...(clonedPayload.properties || {}), ...properties };
    return clonedPayload;
  }

  /** Themes often POST JSON to /cart/add.js without Content-Type: application/json. */
  function tryParseCartJsonBodyString(str) {
    if (typeof str !== "string") return null;
    const t = str.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
    try {
      return JSON.parse(str);
    } catch (_e) {
      return null;
    }
  }

  function isCartAddRequest(url, method) {
    if ((method || "GET").toUpperCase() !== "POST") return false;
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.pathname === "/cart/add" || parsed.pathname === "/cart/add.js";
    } catch (_error) {
      return false;
    }
  }

  function setupCartAddFetchInterceptor() {
    if (window.__printdockFetchPatched) return;
    window.__printdockFetchPatched = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input?.url || "";
      const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
      if (!isCartAddRequest(requestUrl, method)) {
        return originalFetch(input, init);
      }

      const validationError = getAddToCartValidationError();
      if (validationError) {
        showError(validationError);
        throw new Error(validationError);
      }

      const properties = getCartProperties();
      if (Object.keys(properties).length === 0) {
        return originalFetch(input, init);
      }

      if (!init && input instanceof Request) {
        try {
          const parsed = await input.clone().json();
          if (parsed && typeof parsed === "object") {
            const nextPayload = mergePropertiesIntoJsonPayload(parsed, properties);
            const headers = new Headers(input.headers);
            headers.set("content-type", "application/json");
            return originalFetch(input.url, {
              method: input.method,
              headers,
              body: JSON.stringify(nextPayload),
              credentials: input.credentials,
              mode: input.mode,
              redirect: input.redirect,
              referrer: input.referrer,
              referrerPolicy: input.referrerPolicy,
              integrity: input.integrity,
              keepalive: input.keepalive,
              signal: input.signal,
            });
          }
        } catch (_error) {
          /* not JSON — try form body */
        }
        const contentType = input.headers.get("content-type") || "";
        if (
          contentType.includes("multipart/form-data") ||
          contentType.includes("application/x-www-form-urlencoded")
        ) {
          try {
            const formData = await input.clone().formData();
            const nextBody = new FormData();
            formData.forEach((value, key) => nextBody.append(key, value));
            applyPropertiesToFormData(nextBody, properties);
            return originalFetch(input.url, {
              method: input.method,
              headers: input.headers,
              body: nextBody,
              credentials: input.credentials,
              mode: input.mode,
              redirect: input.redirect,
              referrer: input.referrer,
              referrerPolicy: input.referrerPolicy,
              integrity: input.integrity,
              keepalive: input.keepalive,
              signal: input.signal,
            });
          } catch (_error) {
            return originalFetch(input, init);
          }
        }
      }

      if (init && init.body instanceof FormData) {
        const nextBody = new FormData();
        init.body.forEach((value, key) => nextBody.append(key, value));
        applyPropertiesToFormData(nextBody, properties);
        return originalFetch(input, { ...init, body: nextBody });
      }

      if (init && typeof init.body === "string") {
        const headers = new Headers(init.headers || {});
        const contentType = headers.get("content-type") || "";
        let parsed = null;
        if (contentType.includes("application/json")) {
          try {
            parsed = JSON.parse(init.body);
          } catch (_error) {
            parsed = null;
          }
        }
        if (!parsed) {
          parsed = tryParseCartJsonBodyString(init.body);
        }
        if (parsed && typeof parsed === "object") {
          const nextPayload = mergePropertiesIntoJsonPayload(parsed, properties);
          headers.set("content-type", "application/json");
          return originalFetch(input, { ...init, headers, body: JSON.stringify(nextPayload) });
        }
      }

      return originalFetch(input, init);
    };
  }

  function setupCartAddXHRInterceptor() {
    if (window.__printdockXHRPatched) return;
    window.__printdockXHRPatched = true;

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__printdockMethod = method;
      this.__printdockUrl = typeof url === "string" ? url : String(url || "");
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      const method = this.__printdockMethod || "GET";
      const url = this.__printdockUrl || "";
      if (!isCartAddRequest(url, method)) {
        return originalSend.call(this, body);
      }

      const validationError = getAddToCartValidationError();
      if (validationError) {
        showError(validationError);
        this.abort();
        return;
      }

      const properties = getCartProperties();
      if (Object.keys(properties).length === 0) {
        return originalSend.call(this, body);
      }

      if (body instanceof FormData) {
        applyPropertiesToFormData(body, properties);
        return originalSend.call(this, body);
      }

      if (body instanceof URLSearchParams) {
        applyPropertiesToSearchParams(body, properties);
        return originalSend.call(this, body);
      }

      if (typeof body === "string") {
        const jsonParsed = tryParseCartJsonBodyString(body);
        if (jsonParsed && typeof jsonParsed === "object") {
          const nextPayload = mergePropertiesIntoJsonPayload(jsonParsed, properties);
          return originalSend.call(this, JSON.stringify(nextPayload));
        }
        try {
          const params = new URLSearchParams(body);
          if (params.has("id") || params.has("items")) {
            applyPropertiesToSearchParams(params, properties);
            return originalSend.call(this, params.toString());
          }
        } catch (_error) {
          return originalSend.call(this, body);
        }
      }

      return originalSend.call(this, body);
    };
  }

  function setHiddenInput(form, name, value) {
    let input = form.querySelector(`input[name="${CSS.escape(name)}"]`);
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  function updateCartState() {
    const successfulFiles = uploadedFiles.filter((entry) => entry.status === "success");
    isBlocked = uploadedFiles.some((entry) => entry.blocked);
    const btn = document.querySelector('[name="add"], [id*="add-to-cart"], .product-form__submit');
    if (!btn) return;

    if (isRequired && successfulFiles.length < Math.max(1, fieldConfig.minFiles)) {
      btn.disabled = true;
      btn.title = "Upload your artwork to continue";
    } else if (isBlocked) {
      btn.disabled = true;
      btn.title = "Please fix the file issues";
    } else {
      btn.disabled = false;
      btn.title = "";
    }
  }

  // ─── PRICE DISPLAY ────────────────────────────────────────────────────
  function updatePriceDisplay() {
    const successfulFiles = uploadedFiles.filter((entry) => entry.status === "success" && entry.pricing);
    if (successfulFiles.length === 0) {
      const el = document.getElementById("printdock-price");
      if (el) el.remove();
      return;
    }

    // Mirror the Cart Transform math so the shopper sees the final line total:
    // line qty × (base variant unit price + upload fee per unit).
    // Sum per-unit file prices, then scale by the current product quantity (line qty).
    const productQuantity = Math.max(1, getProductQuantity());
    const unitTotal = successfulFiles.reduce((sum, entry) => {
      const fileUnitPrice =
        entry.pricing.filePrice != null ? Number(entry.pricing.filePrice) : Number(entry.pricing.total);
      if (!Number.isFinite(fileUnitPrice) || fileUnitPrice <= 0) return sum;
      return sum + fileUnitPrice;
    }, 0);
    const baseUnitPrice = Number.isFinite(BASE_VARIANT_PRICE) && BASE_VARIANT_PRICE > 0
      ? BASE_VARIANT_PRICE
      : 0;
    const finalUnitPrice = baseUnitPrice + unitTotal;
    const total = Math.round(finalUnitPrice * productQuantity * 100) / 100;

    let priceEl = document.getElementById("printdock-price");
    if (!priceEl) {
      priceEl = document.createElement("div");
      priceEl.id = "printdock-price";
      root.appendChild(priceEl);
    }

    priceEl.innerHTML = `
      <div class="printdock-price-display">
        <span class="printdock-price-label">${escapeHtml(LABELS.priceLabel)}</span>
        <span class="printdock-price-amount">$${total.toFixed(2)}</span>
        <span class="printdock-price-explanation">
          ${successfulFiles.length} file(s) in session · per unit: $${baseUnitPrice.toFixed(2)} base + $${unitTotal.toFixed(2)} upload fee
        </span>
      </div>
    `;
  }

  function getProductQuantity() {
    const form = document.querySelector('form[action*="/cart/add"]');
    const quantityInput = form ? form.querySelector('input[name="quantity"]') : null;
    const quantity = quantityInput ? Number(quantityInput.value) : 1;
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  }

  function defaultFileQuantity() {
    return getProductQuantity();
  }

  function updateFileQuantity(fileId, quantity) {
    const file = uploadedFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    file.quantity = Math.max(1, quantity);
    updatePriceDisplay();
    updateCartState();
  }

  function removeFile(fileId) {
    uploadedFiles = uploadedFiles.filter((entry) => {
      if (entry.id !== fileId) return true;
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      return false;
    });
    if (uploadedFiles.length === 0) {
      sessionToken = null;
      sessionExpiresAt = null;
      localStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(SESSION_EXPIRES_STORAGE_KEY);
    }
    renderFileList();
    updateCartState();
    updatePriceDisplay();
  }

  // ─── RENDER ──────────────────────────────────────────────────────────
  function renderUI() {
    const title = fieldConfig.storefrontTitle || "Upload your artwork";
    const description = fieldConfig.storefrontDescription || "";
    const supported = fieldConfig.allowedExtensions.map((ext) => ext.toUpperCase()).join(", ");

    root.innerHTML = `
      <div class="printdock-upload">
        <div class="printdock-copy">
          <p class="printdock-drop-title">${escapeHtml(title)}</p>
          ${description ? `<p class="printdock-drop-sub">${escapeHtml(description)}</p>` : ""}
        </div>
        <div class="printdock-dropzone" id="printdock-dropzone">
          <input type="file" id="printdock-file-input" accept="${escapeHtml(inputAccept())}" ${fieldConfig.maxFiles > 1 ? "multiple" : ""} hidden>
          <div class="printdock-drop-content">
            <div class="printdock-drop-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
            </div>
            <p class="printdock-drop-title">${escapeHtml(LABELS.dropHeadline)}</p>
            <p class="printdock-drop-sub">${supported} — up to ${fieldConfig.maxFileMB}MB · max ${fieldConfig.maxFiles} file(s)</p>
            <button type="button" class="printdock-choose-btn" id="printdock-choose-btn">${escapeHtml(LABELS.chooseLabel)}</button>
          </div>
        </div>
        <div class="printdock-file-list" id="printdock-file-list"></div>
        <div class="printdock-messages" id="printdock-messages"></div>
      </div>
    `;

    // Wire up events
    const dropzone = document.getElementById("printdock-dropzone");
    const fileInput = document.getElementById("printdock-file-input");
    const chooseBtn = document.getElementById("printdock-choose-btn");

    chooseBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => handleFiles(Array.from(e.target.files || [])));

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("printdock-dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("printdock-dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("printdock-dragover");
      handleFiles(Array.from(e.dataTransfer.files || []));
    });
  }

  function renderFileList() {
    const list = document.getElementById("printdock-file-list");
    if (!list) return;

    if (uploadedFiles.length === 0) {
      list.innerHTML = "";
      return;
    }

    list.innerHTML = uploadedFiles
      .map((file) => {
        const escapedName = escapeHtml(file.name);
        const warningHtml = (file.validationResults || [])
          .filter((rule) => rule.severity === "warning")
          .map((rule) => `<div class="printdock-warning">${escapeHtml(rule.message)}</div>`)
          .join("");
        const blockingMessages = (file.validationResults || [])
          .filter((rule) => rule.severity === "blocking")
          .map((rule) => rule.message)
          .join(", ");
        const showQuantity = false;
        const propertyLabels = [];
        if (file.metadata?.widthInch && file.metadata?.heightInch) {
          propertyLabels.push(`${file.metadata.widthInch.toFixed(1)}" × ${file.metadata.heightInch.toFixed(1)}"`);
        }
        if (file.metadata?.dpi) {
          propertyLabels.push(`${file.metadata.dpi} DPI`);
        }
        propertyLabels.push(formatBytes(file.size));
        const propsHtml = propertyLabels
          .map((label, index) =>
            `${index > 0 ? '<span class="sep">|</span>' : ""}<span>${escapeHtml(label)}</span>`,
          )
          .join("");
        const progressHtml =
          file.status === "uploading"
            ? `
              <div class="printdock-progress-wrap">
                <div class="printdock-progress-bar">
                  <div class="printdock-progress-fill" style="width:${file.progress}%"></div>
                </div>
                <span class="printdock-status">${file.progress}%</span>
              </div>
            `
            : "";
        const validatingHtml =
          file.status === "validating" ? `<span class="printdock-status">${escapeHtml(LABELS.checkingLabel)}</span>` : "";
        const thumbnailHtml = file.previewUrl
          ? `<img src="${escapeHtml(file.previewUrl)}" alt="" loading="lazy" />`
          : `
            <svg viewBox="0 0 20 20" width="22" height="22" fill="none" aria-hidden="true">
              <path d="M6 2.5h5.5l4 4V16a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4.5 16V4A1.5 1.5 0 0 1 6 2.5Z" stroke="currentColor" stroke-width="1.5"/>
              <path d="M11.5 2.5V6a.5.5 0 0 0 .5.5h3.5" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          `;

        return `
          <div class="printdock-file-card printdock-file-${file.status}">
            <div class="printdock-file-thumb">
              ${thumbnailHtml}
            </div>
            <div class="printdock-file-body">
              <span class="printdock-file-name" title="${escapedName}">${escapedName}</span>
              <div class="printdock-file-props">${propsHtml}</div>
              ${progressHtml}
              ${validatingHtml}
              ${warningHtml}
              ${file.blocked ? `<div class="printdock-error">${escapeHtml(blockingMessages)}</div>` : ""}
              ${file.status === "error" ? `<div class="printdock-error">${escapeHtml(file.error || "Upload failed")}</div>` : ""}
              ${showQuantity ? `
                <label class="printdock-status">
                  Quantity:
                  <input
                    type="number"
                    min="1"
                    class="printdock-qty-input"
                    data-file-id="${file.id}"
                    value="${Number(file.quantity || 1)}"
                  />
                </label>
              ` : ""}
            </div>
            <button type="button" class="printdock-remove-btn" data-file-id="${file.id}" aria-label="Remove ${escapedName}">
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        `;
      })
      .join("");

    list.querySelectorAll(".printdock-remove-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const fileId = button.getAttribute("data-file-id");
        if (fileId) removeFile(fileId);
      });
    });

    list.querySelectorAll(".printdock-qty-input").forEach((input) => {
      input.addEventListener("change", () => {
        const fileId = input.getAttribute("data-file-id");
        const quantity = Number(input.value || 1);
        if (fileId) updateFileQuantity(fileId, quantity);
      });
    });
  }

  function showError(msg) {
    const msgs = document.getElementById("printdock-messages");
    if (msgs) msgs.innerHTML = `<div class="printdock-error">${escapeHtml(msg)}</div>`;
    setTimeout(() => { if (msgs) msgs.innerHTML = ""; }, 4000);
  }

  // ─── UTILS ───────────────────────────────────────────────────────────
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── BOOTSTRAP ───────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();