(function () {
  "use strict";

  const root = document.getElementById("printdock-upload-root");
  if (!root) return;

  const PRODUCT_ID = root.dataset.productId;
  const IS_REQUIRED = root.dataset.required === "true";
  const SESSION_STORAGE_KEY = `printdock_session_${PRODUCT_ID}`;
  const PROXY_URL = "/apps/printdock"; // Configured in shopify.app.toml

  let sessionToken = null;
  let uploadedFile = null; // Strict 1-file limit for Firebase MVP
  let isBlocked = false;

  // ─── INIT ────────────────────────────────────────────────────────────
  async function init() {
    renderUI();
    setupAddToCartGuard();
  }

  // ─── FILE UPLOAD ──────────────────────────────────────────────────────
  async function handleFiles(files) {
    if (files.length === 0) return;
    // We only take the first file due to the single-file constraint
    await uploadFile(files[0]);
  }

  async function uploadFile(file) {
    const fileEntry = {
      id: Math.random().toString(36).slice(2),
      name: file.name,
      size: file.size,
      status: "uploading",
      progress: 0,
      metadata: null,
      pricing: null,
      validationResults: [],
      blocked: false,
    };

    uploadedFile = fileEntry;
    renderFileList();

    try {
      // Step 1: Get presigned URL from our App Proxy
      const sessionRes = await fetch(`${PROXY_URL}/api/proxy/upload/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: PRODUCT_ID,
          variantId: root.dataset.variantId || "",
          fileName: file.name,
          mimeType: file.type,
        }),
      });
      
      if (!sessionRes.ok) throw new Error("Failed to get upload session");
      
      const sessionData = await sessionRes.json();
      sessionToken = sessionData.sessionToken;
      localStorage.setItem(SESSION_STORAGE_KEY, sessionToken);
      const { presignedUrl, storagePath } = sessionData;

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
        }),
      });
      
      if (!confirmRes.ok) throw new Error("Validation failed");
      
      const confirmData = await confirmRes.json();

      fileEntry.status = confirmData.blocked ? "blocked" : "success";
      fileEntry.metadata = confirmData.metadata;
      fileEntry.pricing = confirmData.pricing;
      fileEntry.validationResults = confirmData.validationResults;
      fileEntry.blocked = confirmData.blocked;

    } catch (err) {
      fileEntry.status = "error";
      fileEntry.error = "Upload failed. Please try again.";
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
      xhr.setRequestHeader("Content-Type", file.type);

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
    const form = document.querySelector('form[action*="/cart/add"]');
    if (!form) return;

    form.addEventListener("submit", (e) => {
      if (IS_REQUIRED && (!uploadedFile || uploadedFile.status !== "success")) {
        e.preventDefault();
        showError("Please upload your artwork before adding to cart.");
        return;
      }
      if (isBlocked) {
        e.preventDefault();
        showError("Please fix the file issues before adding to cart.");
        return;
      }
      injectCartProperties(form);
    });
  }

  function injectCartProperties(form) {
    if (!sessionToken || !uploadedFile || uploadedFile.status !== "success") return;

    setHiddenInput(form, "properties[_uc_session]", sessionToken);

    const m = uploadedFile.metadata;
    if (m?.widthInch && m?.heightInch) {
      const dims = `${m.widthInch.toFixed(1)}" × ${m.heightInch.toFixed(1)}"`;
      setHiddenInput(form, "properties[Artwork size]", dims);
    } else {
      setHiddenInput(form, "properties[Artwork]", uploadedFile.name);
    }
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
    isBlocked = uploadedFile ? uploadedFile.blocked : false;
    const btn = document.querySelector('[name="add"], [id*="add-to-cart"], .product-form__submit');
    if (!btn) return;

    if (IS_REQUIRED && (!uploadedFile || uploadedFile.status !== "success")) {
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
    if (!uploadedFile || uploadedFile.status !== "success" || !uploadedFile.pricing) {
      const el = document.getElementById("printdock-price");
      if (el) el.remove();
      return;
    }

    const total = uploadedFile.pricing.total;
    const explanation = uploadedFile.pricing.explanation;

    let priceEl = document.getElementById("printdock-price");
    if (!priceEl) {
      priceEl = document.createElement("div");
      priceEl.id = "printdock-price";
      root.appendChild(priceEl);
    }

    priceEl.innerHTML = `
      <div class="printdock-price-display">
        <span class="printdock-price-label">Upload price:</span>
        <span class="printdock-price-amount">$${total.toFixed(2)}</span>
        <span class="printdock-price-explanation">${explanation}</span>
      </div>
    `;
  }

  // ─── RENDER ──────────────────────────────────────────────────────────
  function renderUI() {
    root.innerHTML = `
      <div class="printdock-upload">
        <div class="printdock-dropzone" id="printdock-dropzone">
          <input type="file" id="printdock-file-input" accept=".png,.jpg,.jpeg,.pdf" hidden>
          <div class="printdock-drop-content">
            <div class="printdock-drop-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
            </div>
            <p class="printdock-drop-title">Drop your artwork here</p>
            <p class="printdock-drop-sub">PNG, PDF, JPG — up to 500MB</p>
            <button type="button" class="printdock-choose-btn" id="printdock-choose-btn">Choose file</button>
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
    fileInput.addEventListener("change", (e) => handleFiles(Array.from(e.target.files)));

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("printdock-dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("printdock-dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("printdock-dragover");
      handleFiles(Array.from(e.dataTransfer.files));
    });
  }

  function renderFileList() {
    const list = document.getElementById("printdock-file-list");
    if (!list) return;

    if (!uploadedFile) {
      list.innerHTML = "";
      return;
    }

    const file = uploadedFile;

    list.innerHTML = `
      <div class="printdock-file-card printdock-file-${file.status}">
        <div class="printdock-file-info">
          <span class="printdock-file-name">${escapeHtml(file.name)}</span>
          <span class="printdock-file-size">${formatBytes(file.size)}</span>
        </div>
        ${file.status === "uploading" ? `
          <div class="printdock-progress-bar">
            <div class="printdock-progress-fill" style="width:${file.progress}%"></div>
          </div>
          <span class="printdock-status">${file.progress}%</span>
        ` : ""}
        ${file.status === "validating" ? `<span class="printdock-status">Checking file...</span>` : ""}
        ${file.status === "success" ? `
          <span class="printdock-status printdock-status-ok">
            ${file.metadata?.widthInch ? `${file.metadata.widthInch.toFixed(1)}" × ${file.metadata.heightInch.toFixed(1)}"` : ""}
            ${file.metadata?.dpi ? `· ${file.metadata.dpi} DPI` : ""}
          </span>
        ` : ""}
        ${file.validationResults?.filter(r => r.severity === "warning").map(r => `
          <div class="printdock-warning">${escapeHtml(r.message)}</div>
        `).join("") ?? ""}
        ${file.blocked ? `<div class="printdock-error">${file.validationResults.filter(r => r.severity === "blocking").map(r => r.message).join(", ")}</div>` : ""}
        ${file.status === "error" ? `<div class="printdock-error">${escapeHtml(file.error)}</div>` : ""}
        <button type="button" class="printdock-remove-btn">Remove</button>
      </div>
    `;

    // Wire remove buttons
    list.querySelector(".printdock-remove-btn").addEventListener("click", () => {
      uploadedFile = null;
      sessionToken = null;
      renderFileList();
      updateCartState();
      updatePriceDisplay();
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