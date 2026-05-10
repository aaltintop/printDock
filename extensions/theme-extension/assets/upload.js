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
  let pagehideCleanupBound = false;

  function clearStoredSession() {
    sessionToken = null;
    sessionExpiresAt = null;
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(SESSION_EXPIRES_STORAGE_KEY);
    } catch (_) {
      // Ignore storage access failures (private mode / blocked storage).
    }
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

  /**
   * Public API error contract (see app/lib/api-error.server.ts):
   *   { error: "snake_case_code", message: "...", reference?: "..." }
   *
   * The shopper-facing message ALWAYS comes from `message`. The `error`
   * code is for client branching ONLY — never displayed.
   */
  function getFriendlyServerMessage(json, fallback) {
    if (json && typeof json === "object" && typeof json.message === "string" && json.message.trim()) {
      return json.message;
    }
    return fallback || "Upload failed. Please refresh the page and try again.";
  }

  /**
   * Heuristic: catch internal/JS error strings before they reach the
   * shopper. A message is considered safe to display if it has reasonable
   * length, ends with punctuation, and does not look like a stack frame or
   * built-in error class name.
   */
  function isLikelyFriendlyMessage(msg) {
    if (typeof msg !== "string") return false;
    const trimmed = msg.trim();
    if (!trimmed || trimmed.length > 240) return false;
    if (/^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|NetworkError|Error):/i.test(trimmed)) {
      return false;
    }
    if (/\bat\s+\w+.*:\d+:\d+/.test(trimmed)) return false; // stack frame
    if (/^[a-z_][a-z0-9_]*$/i.test(trimmed)) return false; // bare snake_case code
    return /[.!?]$/.test(trimmed) || trimmed.length < 80;
  }

  function isStaleSessionError(status, json) {
    if (status !== 400) return false;
    const code = String(json?.error || "");
    // Codes that mean: the session is no longer aligned with the current
    // product/cart state, retry with a fresh token.
    return code === "session_invalid" || code === "max_files";
  }

  const Preflight = (() => {
    const MAX_PIXELS = 10000 * 10000;
    const HEADER_READ_BYTES = 512 * 1024;

    function bytesToString(bytes, start, end) {
      let out = "";
      for (let i = start; i < end && i < bytes.length; i += 1) {
        out += String.fromCharCode(bytes[i]);
      }
      return out;
    }

    function readHead(file, maxBytes = HEADER_READ_BYTES) {
      return file.slice(0, maxBytes).arrayBuffer().then((buf) => new Uint8Array(buf));
    }

    async function magicMime(file) {
      const header = await readHead(file, 16);
      if (
        header.length >= 8 &&
        header[0] === 0x89 &&
        header[1] === 0x50 &&
        header[2] === 0x4e &&
        header[3] === 0x47 &&
        header[4] === 0x0d &&
        header[5] === 0x0a &&
        header[6] === 0x1a &&
        header[7] === 0x0a
      ) {
        return "image/png";
      }
      if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
        return "image/jpeg";
      }
      if (
        header.length >= 12 &&
        bytesToString(header, 0, 4) === "RIFF" &&
        bytesToString(header, 8, 12) === "WEBP"
      ) {
        return "image/webp";
      }
      if (header.length >= 6) {
        const sig = bytesToString(header, 0, 6);
        if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
      }
      if (
        header.length >= 5 &&
        header[0] === 0x25 &&
        header[1] === 0x50 &&
        header[2] === 0x44 &&
        header[3] === 0x46 &&
        header[4] === 0x2d
      ) {
        return "application/pdf";
      }
      return file.type || "application/octet-stream";
    }

    function parsePngDimensions(bytes) {
      if (bytes.length < 24) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        width: view.getUint32(16, false),
        height: view.getUint32(20, false),
      };
    }

    function parseJpegDimensions(bytes) {
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i += 1;
          continue;
        }
        while (i < bytes.length && bytes[i] === 0xff) i += 1;
        if (i >= bytes.length) break;
        const marker = bytes[i];
        i += 1;
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (i + 1 >= bytes.length) break;
        const length = (bytes[i] << 8) | bytes[i + 1];
        if (length < 2 || i + length > bytes.length) break;
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          if (length >= 7) {
            return {
              height: (bytes[i + 3] << 8) | bytes[i + 4],
              width: (bytes[i + 5] << 8) | bytes[i + 6],
            };
          }
        }
        i += length;
      }
      return null;
    }

    function parsePngDpi(bytes) {
      if (bytes.length < 40) return null;
      let offset = 8;
      while (offset + 12 <= bytes.length) {
        const length =
          ((bytes[offset] << 24) >>> 0) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3];
        const type = bytesToString(bytes, offset + 4, offset + 8);
        const dataStart = offset + 8;
        const next = dataStart + length + 4;
        if (next > bytes.length) break;
        if (type === "pHYs" && length >= 9) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, length);
          const xPpu = view.getUint32(0, false);
          const yPpu = view.getUint32(4, false);
          const unit = view.getUint8(8);
          if (unit !== 1 || !xPpu || !yPpu) return null;
          return Math.round(((xPpu + yPpu) / 2) * 0.0254);
        }
        offset = next;
      }
      return null;
    }

    function readRational(view, offset, littleEndian) {
      if (offset + 8 > view.byteLength) return null;
      const numerator = view.getUint32(offset, littleEndian);
      const denominator = view.getUint32(offset + 4, littleEndian);
      if (!denominator) return null;
      return numerator / denominator;
    }

    function parseExifDpi(app1) {
      if (app1.length < 14 || bytesToString(app1, 0, 6) !== "Exif\u0000\u0000") return null;
      const tiffOffset = 6;
      const view = new DataView(app1.buffer, app1.byteOffset + tiffOffset, app1.length - tiffOffset);
      if (view.byteLength < 8) return null;

      const byteOrder = String.fromCharCode(view.getUint8(0), view.getUint8(1));
      const littleEndian = byteOrder === "II";
      if (!littleEndian && byteOrder !== "MM") return null;
      if (view.getUint16(2, littleEndian) !== 0x2a) return null;

      const ifdOffset = view.getUint32(4, littleEndian);
      if (ifdOffset + 2 > view.byteLength) return null;
      const entryCount = view.getUint16(ifdOffset, littleEndian);
      let xRes = null;
      let yRes = null;
      let unit = 2;

      for (let idx = 0; idx < entryCount; idx += 1) {
        const entryOffset = ifdOffset + 2 + idx * 12;
        if (entryOffset + 12 > view.byteLength) break;
        const tag = view.getUint16(entryOffset, littleEndian);
        const valueOffset = view.getUint32(entryOffset + 8, littleEndian);
        if (tag === 0x011a || tag === 0x011b) {
          const val = readRational(view, valueOffset, littleEndian);
          if (val) {
            if (tag === 0x011a) xRes = val;
            if (tag === 0x011b) yRes = val;
          }
        } else if (tag === 0x0128) {
          unit = view.getUint16(entryOffset + 8, littleEndian);
        }
      }

      const avg = xRes && yRes ? (xRes + yRes) / 2 : xRes || yRes;
      if (!avg) return null;
      if (unit === 3) return Math.round(avg * 2.54);
      return Math.round(avg);
    }

    function parseJpegDpi(bytes) {
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
      let i = 2;
      while (i + 4 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i += 1;
          continue;
        }
        while (i < bytes.length && bytes[i] === 0xff) i += 1;
        if (i >= bytes.length) break;
        const marker = bytes[i];
        i += 1;
        if (i + 1 >= bytes.length) break;
        const segmentLength = (bytes[i] << 8) | bytes[i + 1];
        if (segmentLength < 2 || i + segmentLength > bytes.length) break;
        const dataStart = i + 2;
        const dataEnd = i + segmentLength;

        if (marker === 0xe0 && segmentLength >= 16 && bytesToString(bytes, dataStart, dataStart + 5) === "JFIF\u0000") {
          const unit = bytes[dataStart + 7];
          const x = (bytes[dataStart + 8] << 8) | bytes[dataStart + 9];
          const y = (bytes[dataStart + 10] << 8) | bytes[dataStart + 11];
          const density = x && y ? (x + y) / 2 : x || y;
          if (!density || unit === 0) return null;
          if (unit === 2) return Math.round(density * 2.54);
          return Math.round(density);
        }

        if (marker === 0xe1) {
          const dpi = parseExifDpi(bytes.slice(dataStart, dataEnd));
          if (dpi) return dpi;
        }
        i += segmentLength;
      }
      return null;
    }

    async function peekImageDimensions(file, mime) {
      const bytes = await readHead(file, HEADER_READ_BYTES);
      if (mime === "image/png") {
        return parsePngDimensions(bytes);
      }
      if (mime === "image/jpeg") {
        return parseJpegDimensions(bytes);
      }
      if (typeof createImageBitmap !== "function") return null;
      try {
        const bitmap = await createImageBitmap(file);
        const dims = { width: bitmap.width, height: bitmap.height };
        if (typeof bitmap.close === "function") bitmap.close();
        return dims;
      } catch (_error) {
        return null;
      }
    }

    function runRulesClient(metadata, rules) {
      const helpers = (typeof window !== "undefined" && window.PrintDockMessages) || null;
      if (helpers && typeof helpers.buildDimensionRuleMessages === "function") {
        return helpers.buildDimensionRuleMessages(rules || [], metadata || {});
      }
      return [];
    }

    async function extractImageMetadataClient(file, mime) {
      const fileSizeMB = Math.round((file.size / (1024 * 1024)) * 100) / 100;
      const dims = await peekImageDimensions(file, mime);
      const widthPx = dims?.width ?? null;
      const heightPx = dims?.height ?? null;
      const bytes = await readHead(file, HEADER_READ_BYTES);
      const dpi =
        mime === "image/png"
          ? parsePngDpi(bytes)
          : mime === "image/jpeg"
            ? parseJpegDpi(bytes)
            : null;

      return {
        widthPx,
        heightPx,
        dpi,
        widthInch: dpi && widthPx ? widthPx / dpi : null,
        heightInch: dpi && heightPx ? heightPx / dpi : null,
        pageCount: null,
        fileSizeMB,
      };
    }

    async function preflightImage(file, config) {
      const mime = await magicMime(file);
      if (!mime.startsWith("image/")) return { skipped: true };

      const dims = await peekImageDimensions(file, mime);
      const px = Number(dims?.width || 0) * Number(dims?.height || 0);
      if (px > MAX_PIXELS) {
        return {
          skipped: false,
          metadata: null,
          blocking: [
            {
              ruleId: "max_pixels",
              severity: "blocking",
              message: "Image resolution is too large for upload.",
              actual: px,
              expected: MAX_PIXELS,
            },
          ],
          warning: [],
        };
      }

      const metadata = await extractImageMetadataClient(file, mime);
      const results = runRulesClient(metadata, config?.dimensionRules ?? []);
      return {
        skipped: false,
        metadata,
        blocking: results.filter((r) => r.severity === "blocking"),
        warning: results.filter((r) => r.severity === "warning"),
      };
    }

    return {
      preflightImage,
      magicMime,
      runRulesClient,
    };
  })();

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
    setupPagehideCleanup();
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
      reportShopperError(
        `You've reached the maximum of ${fieldConfig.maxFiles} file(s) for this upload.`,
        { code: "max_files" },
      );
      return;
    }
    const selectedFiles = files.slice(0, slotsLeft);

    if (isUploading) {
      reportShopperError("Please wait until the current upload finishes.");
      return;
    }

    isUploading = true;
    for (const selected of selectedFiles) {
      if (!isValidExtension(selected.name)) {
        reportShopperError(
          `This file type is not allowed. Supported: ${fieldConfig.allowedExtensions.join(", ").toUpperCase()}.`,
          { fileName: selected.name, code: "extension_not_allowed" },
        );
        continue;
      }

      const maxBytes = fieldConfig.maxFileMB * 1024 * 1024;
      if (selected.size > maxBytes) {
        reportShopperError(
          `This file is too large. Maximum allowed: ${fieldConfig.maxFileMB}MB.`,
          { fileName: selected.name, code: "file_too_large" },
        );
        continue;
      }
      let preflight = null;
      try {
        preflight = await Preflight.preflightImage(selected, fieldConfig);
      } catch (err) {
        console.warn("PrintDock preflight failed; falling back to server validation", err);
      }

      if (preflight && !preflight.skipped && preflight.blocking.length > 0) {
        const msg = preflight.blocking
          .map((result) => result.message)
          .filter(Boolean)
          .join(" \u00b7 ");
        reportShopperError(msg || "This file does not meet the upload requirements.", {
          fileName: selected.name,
        });
        continue;
      }

      await uploadFile(selected, preflight);
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

  function maxUploadSlots() {
    const max = Number(fieldConfig.maxFiles);
    return Number.isFinite(max) && max > 0 ? Math.floor(max) : 1;
  }

  function isUploadSelectionDisabled() {
    return uploadedFiles.length >= maxUploadSlots();
  }

  async function uploadFile(file, preflight = null) {
    const preflightWarnings = (preflight?.warning ?? []).map((entry) => ({
      ruleId: entry.ruleId || "preflight_warning",
      severity: "warning",
      message: entry.message || "Potential file issue detected.",
      actual: Number.isFinite(entry.actual) ? entry.actual : null,
      expected: Number.isFinite(entry.expected) ? entry.expected : 0,
    }));
    const fileEntry = {
      id: Math.random().toString(36).slice(2),
      name: file.name,
      size: file.size,
      previewUrl: file.type && file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      status: "uploading",
      progress: 0,
      metadata: preflight?.metadata ?? null,
      pricing: null,
      validationResults: preflightWarnings,
      blocked: false,
      quantity: defaultFileQuantity(),
      storagePath: null,
      printReadyFileUrl: null,
      xhrUpload: null,
    };
    const isEntryActive = () => uploadedFiles.some((entry) => entry.id === fileEntry.id);

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
          const storageMsg = getFriendlyServerMessage(
            sessionResult.json,
            "This shop has reached its upload storage limit. Please contact the merchant.",
          );
          // Storage cap is shop-wide and won't change by retrying — surface
          // it as a persistent banner so the shopper notices and stops.
          reportShopperError(storageMsg, { code: "storage_cap_exceeded" });
          fileEntry.status = "error";
          fileEntry.error = storageMsg;
          if (isEntryActive()) {
            renderFileList();
            updateCartState();
            updatePriceDisplay();
          }
          return;
        }
        // Server logs the underlying cause (and on 5xx returns a short
        // reference id); the shopper only sees the friendly `message`.
        console.warn("PrintDock session error", {
          status: sessionResult.status,
          code: sessionResult.json?.error,
          reference: sessionResult.json?.reference,
        });
        const friendlyMsg = getFriendlyServerMessage(sessionResult.json);
        reportShopperError(friendlyMsg, {
          fileName: file.name,
          code: sessionResult.json?.error,
        });
        throw new Error(friendlyMsg);
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
        if (!isEntryActive()) return;
        fileEntry.progress = progress;
        if (!updateUploadingProgressUI(fileEntry)) {
          renderFileList();
        }
      }, (xhr) => {
        fileEntry.xhrUpload = xhr;
      });
      fileEntry.xhrUpload = null;
      if (!isEntryActive()) return;

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
        if (!isEntryActive()) return;
        if (confirmRes.status === 402 && confirmData?.error === "storage_cap_exceeded") {
          console.warn("PrintDock storage cap hit", confirmData);
          const storageMsg = getFriendlyServerMessage(
            confirmData,
            "This shop has reached its upload storage limit. Please contact the merchant.",
          );
          reportShopperError(storageMsg, { code: "storage_cap_exceeded" });
          throw new Error(storageMsg);
        }
        console.warn("PrintDock confirm error", {
          status: confirmRes.status,
          code: confirmData?.error,
          reference: confirmData?.reference,
        });
        const friendlyMsg = getFriendlyServerMessage(confirmData);
        reportShopperError(friendlyMsg, {
          fileName: file.name,
          code: confirmData?.error,
        });
        throw new Error(friendlyMsg);
      }

      if (!isEntryActive()) return;
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
      if (!isEntryActive()) return;
      fileEntry.status = "error";
      const rawMsg = err instanceof Error ? err.message : String(err);
      // Errors thrown by our own code (session/confirm/XHR helpers) are
      // already shopper-friendly. Anything else (`TypeError: …`, internal
      // JS exceptions, etc.) gets replaced with a generic fallback so the
      // shopper never sees a stack frame or technical jargon.
      fileEntry.error = isLikelyFriendlyMessage(rawMsg)
        ? rawMsg
        : "Upload failed. Please refresh the page and try again.";
      console.error("PrintDock upload error:", err);
    }

    if (!isEntryActive()) return;
    renderFileList();
    updateCartState();
    updatePriceDisplay();
  }

  async function uploadToFirebase(file, presignedUrl, onProgress, onCreateXhr) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      if (typeof onCreateXhr === "function") onCreateXhr(xhr);
      xhr.open("PUT", presignedUrl, true);
      xhr.setRequestHeader(
        "Content-Type",
        file.type && file.type.trim() !== "" ? file.type : "application/octet-stream",
      );

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          resolve();
          return;
        }
        // The shopper does not care about the HTTP status; the dev console
        // gets the detail so support can follow up if needed.
        console.warn("PrintDock storage upload failed", { status: xhr.status });
        reject(new Error("We couldn't upload your file. Please check your connection and try again."));
      };
      xhr.onerror = () =>
        reject(new Error("We couldn't reach our storage service. Please check your connection and try again."));
      xhr.onabort = () => reject(new Error("Upload canceled."));
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
    clearPrintdockHiddenInputs(form);
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
      const baseUnitPrice = Number.isFinite(BASE_VARIANT_PRICE) && BASE_VARIANT_PRICE > 0
        ? BASE_VARIANT_PRICE
        : 0;
      const finalUnitPrice = baseUnitPrice + unitPriceForLine;
      properties["Upload pricing"] =
        `$${baseUnitPrice.toFixed(2)} base + $${unitPriceForLine.toFixed(2)} upload fee = $${finalUnitPrice.toFixed(2)} per unit`;
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
      input.dataset.printdockProperty = "1";
      form.appendChild(input);
    }
    input.value = value;
  }

  function clearPrintdockHiddenInputs(form) {
    form.querySelectorAll('input[data-printdock-property="1"]').forEach((input) => input.remove());
  }

  function syncFormProperties() {
    const forms = document.querySelectorAll('form[action*="/cart/add"]');
    forms.forEach((form) => injectCartProperties(form));
  }

  function updateCartState() {
    const successfulFiles = uploadedFiles.filter((entry) => entry.status === "success");
    isBlocked = uploadedFiles.some((entry) => entry.blocked);
    syncFormProperties();
    syncUploadControls();
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

  async function requestServerRemove(uploadSessionToken, storagePath, options) {
    if (!uploadSessionToken || !storagePath) return;
    const body = JSON.stringify({ sessionToken: uploadSessionToken, storagePath });
    const keepalive = options?.keepalive !== false;
    try {
      await fetch(`${PROXY_URL}/api/proxy/upload/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive,
      });
    } catch (_error) {
      // Best-effort cleanup. Orphan sweep remains safety net.
    }
  }

  function requestServerRemoveWithBeacon(uploadSessionToken, storagePath) {
    if (!uploadSessionToken || !storagePath) return false;
    if (!navigator?.sendBeacon) return false;
    try {
      const body = JSON.stringify({
        sessionToken: uploadSessionToken,
        storagePath,
      });
      return navigator.sendBeacon(
        `${PROXY_URL}/api/proxy/upload/remove`,
        new Blob([body], { type: "application/json" }),
      );
    } catch (_error) {
      return false;
    }
  }

  function setupPagehideCleanup() {
    if (pagehideCleanupBound) return;
    pagehideCleanupBound = true;
    window.addEventListener("pagehide", () => {
      if (!sessionToken) return;
      const inFlight = uploadedFiles.filter(
        (entry) => entry.status === "uploading" && entry.storagePath,
      );
      for (const entry of inFlight) {
        requestServerRemoveWithBeacon(sessionToken, entry.storagePath);
      }
    });
  }

  function removeFile(fileId) {
    const target = uploadedFiles.find((entry) => entry.id === fileId);
    if (!target) return;
    const removeSessionToken = sessionToken;
    const removeStoragePath = target.storagePath;
    if (target.xhrUpload) {
      try {
        target.xhrUpload.abort();
      } catch (_error) {
        // Ignore abort errors from browsers/themes with patched XHR.
      }
      target.xhrUpload = null;
    }
    if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);

    if (removeSessionToken && removeStoragePath) {
      requestServerRemove(removeSessionToken, removeStoragePath, { keepalive: true });
    }

    uploadedFiles = uploadedFiles.filter((entry) => entry.id !== fileId);
    if (uploadedFiles.length === 0) {
      clearStoredSession();
      const fileInput = document.getElementById("printdock-file-input");
      if (fileInput) fileInput.value = "";
      // Reset all shopper notifications when the form is fully cleared
      // (e.g. after the cart converts the session). Old banners about a
      // previous attempt would otherwise stay around.
      activeBanners.forEach((_, id) => dismissBanner(id));
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
        <!-- Inline alerts sit between the dropzone and the file list so they
             land squarely in the shopper's gaze right after they drop a file
             (Stripe / Google Drive pattern). Newest banner is appended last
             so it appears at the bottom — closest to the dropzone the
             shopper just interacted with. -->
        <div class="printdock-banner-stack" id="printdock-banner-stack" aria-live="polite" aria-atomic="false"></div>
        <div class="printdock-file-list" id="printdock-file-list"></div>
      </div>
    `;

    // Wire up events
    const dropzone = document.getElementById("printdock-dropzone");
    const fileInput = document.getElementById("printdock-file-input");
    const chooseBtn = document.getElementById("printdock-choose-btn");

    chooseBtn.addEventListener("click", () => {
      if (isUploadSelectionDisabled()) return;
      fileInput.click();
    });
    fileInput.addEventListener("change", (e) => handleFiles(Array.from(e.target.files || [])));

    dropzone.addEventListener("dragover", (e) => {
      if (isUploadSelectionDisabled()) return;
      e.preventDefault();
      dropzone.classList.add("printdock-dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("printdock-dragover"));
    dropzone.addEventListener("drop", (e) => {
      if (isUploadSelectionDisabled()) return;
      e.preventDefault();
      dropzone.classList.remove("printdock-dragover");
      handleFiles(Array.from(e.dataTransfer.files || []));
    });

    syncUploadControls();
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
                <div class="printdock-progress-bar" style="--pd-progress:${file.progress}%">
                </div>
                <span class="printdock-status printdock-progress-percent">${file.progress}%</span>
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
          <div class="printdock-file-card printdock-file-${file.status}" data-file-id="${file.id}">
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

  function updateUploadingProgressUI(fileEntry) {
    const card = root.querySelector(`.printdock-file-card[data-file-id="${fileEntry.id}"]`);
    if (!card) return false;

    const progressBar = card.querySelector(".printdock-progress-bar");
    const progressText = card.querySelector(".printdock-progress-percent");

    if (!progressBar && !progressText) return false;

    if (progressBar) {
      progressBar.style.setProperty("--pd-progress", `${fileEntry.progress}%`);
    }
    if (progressText) {
      progressText.textContent = `${fileEntry.progress}%`;
    }

    return true;
  }

  function syncUploadControls() {
    const dropzone = document.getElementById("printdock-dropzone");
    const fileInput = document.getElementById("printdock-file-input");
    const chooseBtn = document.getElementById("printdock-choose-btn");
    if (!dropzone || !fileInput || !chooseBtn) return;

    const disabled = isUploadSelectionDisabled();

    chooseBtn.disabled = disabled;
    chooseBtn.setAttribute("aria-disabled", disabled ? "true" : "false");

    fileInput.disabled = disabled;

    dropzone.classList.toggle("printdock-dropzone-disabled", disabled);
    dropzone.setAttribute("aria-disabled", disabled ? "true" : "false");
    if (disabled) dropzone.classList.remove("printdock-dragover");
  }

  // ─── SHOPPER NOTIFICATIONS ──────────────────────────────────────────
  // Inline banner stack lives inside the upload block, between the
  // dropzone and the file list. This is where the shopper's gaze lands
  // right after they interact with the dropzone (Stripe / Google Drive
  // pattern) so the alert is impossible to miss — no floating overlay,
  // no theme-footer collisions, no off-screen toasts.
  //
  // Two behaviours sharing the same surface:
  //   • Ordinary errors (wrong file type, too large, transient network
  //     hiccup): auto-dismiss after 7s with a hover/focus-pausable
  //     countdown bar and an always-available X button.
  //   • Critical errors (storage cap, plan-required, expired/invalid
  //     session, link invalid, global file size limit): NEVER auto-
  //     dismiss — the shopper must read and act (refresh, contact
  //     merchant, etc.). Manual X only.
  //
  // Per-file errors that should stick to the file card itself remain
  // rendered inline by `renderFileList` via `fileEntry.error`.

  const BANNER_AUTO_DISMISS_MS = 7000;
  const BANNER_STACK_LIMIT = 5;

  // Codes that the shopper cannot resolve by simply retrying — they need
  // to read the message and take a concrete action. Auto-dismiss is
  // suppressed for these, so they stay visible until the shopper clicks X.
  const PERSISTENT_BANNER_CODES = new Set([
    "storage_cap_exceeded",
    "plan_required",
    "session_expired",
    "session_invalid",
    "link_invalid",
    "file_too_large_global",
  ]);

  const BANNER_TITLE_BY_CODE = {
    storage_cap_exceeded: "Storage limit reached",
    plan_required: "Uploads unavailable",
    session_expired: "Session expired",
    session_invalid: "Upload session is no longer valid",
    link_invalid: "Download link is no longer valid",
    file_too_large_global: "File is too large to upload",
  };

  let notifyIdCounter = 0;
  const activeBanners = new Map();

  const ICON_ALERT = `
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" stroke="currentColor" stroke-width="1.5"/>
      <path d="M10 6v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="10" cy="13.5" r="0.9" fill="currentColor"/>
    </svg>`;
  const ICON_DISMISS = `
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;

  function ensureBannerStack() {
    return document.getElementById("printdock-banner-stack");
  }

  function dismissBanner(id) {
    const state = activeBanners.get(id);
    if (!state) return;
    if (state.timerId) clearTimeout(state.timerId);
    state.element.classList.add("printdock-banner-dismissed");
    setTimeout(() => {
      state.element.remove();
      activeBanners.delete(id);
    }, 180);
  }

  function enforceBannerLimit(stack) {
    const visible = stack.querySelectorAll(".printdock-banner");
    for (let i = 0; i < visible.length - BANNER_STACK_LIMIT; i++) {
      const id = Number(visible[i].getAttribute("data-banner-id"));
      if (id) dismissBanner(id);
    }
  }

  function showBanner(message, opts = {}) {
    const stack = ensureBannerStack();
    if (!stack) {
      // Block isn't rendered yet (very rare — upload.js runs after the
      // template is injected). Surface the error in the console so it's
      // recoverable from devtools at least.
      console.warn("PrintDock alert (no banner stack):", { message, opts });
      return null;
    }

    // De-dupe by code so a single condition (e.g. storage cap) doesn't
    // pile up identical banners as the shopper retries uploads.
    if (opts.code) {
      activeBanners.forEach((state, existingId) => {
        if (state.code === opts.code) dismissBanner(existingId);
      });
    }

    const id = ++notifyIdCounter;
    const code = opts.code || null;
    const autoDismiss = !(code && PERSISTENT_BANNER_CODES.has(code));
    const durationMs = Number.isFinite(opts.durationMs)
      ? opts.durationMs
      : BANNER_AUTO_DISMISS_MS;

    const banner = document.createElement("div");
    banner.className = "printdock-banner";
    banner.setAttribute("role", "alert");
    banner.setAttribute("data-banner-id", String(id));
    if (code) banner.setAttribute("data-code", code);
    if (autoDismiss) {
      banner.classList.add("printdock-banner-auto-dismiss");
      banner.style.setProperty("--pd-banner-duration", `${durationMs}ms`);
    }

    const heading =
      opts.fileName ||
      BANNER_TITLE_BY_CODE[code || ""] ||
      "We need your attention";

    banner.innerHTML = `
      <span class="printdock-banner-icon">${ICON_ALERT}</span>
      <div class="printdock-banner-body">
        <div class="printdock-banner-title">${escapeHtml(heading)}</div>
        <div class="printdock-banner-message">${escapeHtml(message)}</div>
      </div>
      <button type="button" class="printdock-banner-dismiss" aria-label="Dismiss notification">${ICON_DISMISS}</button>
    `;

    // Newest at the bottom: closest to the dropzone (where the shopper
    // just clicked / dropped). Drop a file → error appears immediately
    // below, in the natural reading flow.
    stack.appendChild(banner);
    enforceBannerLimit(stack);

    const state = {
      element: banner,
      code,
      remainingMs: durationMs,
      startedAt: Date.now(),
      paused: false,
      timerId: null,
      autoDismiss,
    };
    activeBanners.set(id, state);

    if (autoDismiss) {
      state.timerId = setTimeout(() => dismissBanner(id), durationMs);

      // Hover / focus pauses both the JS timer and the CSS countdown
      // bar — shoppers reading a long message shouldn't have it
      // disappear out from under them.
      const pause = () => {
        if (state.paused) return;
        state.paused = true;
        banner.setAttribute("data-paused", "true");
        const elapsed = Date.now() - state.startedAt;
        state.remainingMs = Math.max(0, state.remainingMs - elapsed);
        if (state.timerId) clearTimeout(state.timerId);
      };
      const resume = () => {
        if (!state.paused) return;
        state.paused = false;
        banner.removeAttribute("data-paused");
        state.startedAt = Date.now();
        state.timerId = setTimeout(() => dismissBanner(id), state.remainingMs);
      };
      banner.addEventListener("mouseenter", pause);
      banner.addEventListener("mouseleave", resume);
      banner.addEventListener("focusin", pause);
      banner.addEventListener("focusout", resume);
    }

    banner
      .querySelector(".printdock-banner-dismiss")
      ?.addEventListener("click", () => dismissBanner(id));

    return id;
  }

  /**
   * Single entry point for shopper-facing feedback. Everything goes
   * through the inline banner stack (no floating toasts). Critical codes
   * stay until manually dismissed; everything else auto-dismisses after
   * 7s with a hover-pausable countdown.
   *
   *   reportShopperError("This file is too large…", {
   *     fileName: "design.psd",
   *     code: "file_too_large",     // optional, routes critical codes
   *     durationMs: 10000,          // optional, override auto-dismiss
   *   })
   */
  function reportShopperError(message, opts = {}) {
    return { kind: "banner", id: showBanner(message, opts) };
  }

  /**
   * Backwards-compatible wrapper. Older call sites pass a single string;
   * newer ones pass `{ fileName, code }` so the shopper sees the file
   * context and critical codes stay persistent.
   */
  function showError(msg, opts) {
    return reportShopperError(msg, opts || {});
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