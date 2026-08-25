const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "tools", "ui-editor.html"), "utf8");

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
});

const { window } = dom;

// jsdom doesn't implement layout, so getBoundingClientRect returns zeros.
// Stub it with plausible values so the editor's percent-math doesn't divide by zero.
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { width: 400, height: 711, top: 0, left: 0, right: 400, bottom: 711 };
};

// jsdom has no Blob/URL.createObjectURL by default in older versions; polyfill minimally.
let savedBlobContent = null;
window.URL.createObjectURL = (blob) => {
  savedBlobContent = blob;
  return "blob:mock";
};
window.URL.revokeObjectURL = () => {};

// jsdom doesn't decode image bytes (no real renderer), so naturalWidth/onload
// never fire for real. Stub it the way the DOM spec behaves for a *valid*
// image: fire onload asynchronously with a plausible size. This tests our
// editor's logic (event wiring, element creation), not image codecs.
window.Image = class extends window.EventTarget {
  set src(value) {
    this._src = value;
    setTimeout(() => {
      this.naturalWidth = 64;
      this.naturalHeight = 64;
      if (this.onload) this.onload();
    }, 5);
  }
  get src() {
    return this._src;
  }
};

// Capture the anchor's simulated click -> read blob text synchronously via blob's internal parts.
// jsdom's Blob supports .text() (async). We intercept at click time.
// The download filename is derived from the Layout Name field (defaults to
// "layout.json" when empty) rather than a fixed name, so match any .json.
let downloadedJsonText = null;
const originalClick = window.HTMLAnchorElement.prototype.click;
window.HTMLAnchorElement.prototype.click = async function () {
  if (this.download && this.download.endsWith(".json") && savedBlobContent) {
    downloadedJsonText = await savedBlobContent.text();
  }
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  await wait(50); // let the inline <script> IIFE finish its initial render()

  const doc = window.document;

  // --- Test 1: inserting a Text element creates a layer ---
  // The per-type toolbar buttons (btn-add-text, btn-add-rect, ...) were
  // replaced by one data-driven Insert palette built from ELEMENT_PRESETS,
  // so every type is reachable through the same [data-insert] control.
  const addTextBtn = doc.querySelector('[data-insert="text"]');
  assert(addTextBtn !== null, "expected an Insert palette entry for the text type");
  addTextBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await wait(10);

  const layerItems = doc.querySelectorAll(".layer-item");
  assert(layerItems.length === 1, `expected 1 layer after Add Text, got ${layerItems.length}`);
  console.log("PASS: Add Text creates a layer");

  // --- Test 2: canvas rendered the element ---
  const uiEls = doc.querySelectorAll("#canvas .ui-el");
  assert(uiEls.length === 1, `expected 1 .ui-el on canvas, got ${uiEls.length}`);
  console.log("PASS: canvas renders the added element");

  // --- Test 3: properties panel shows fields for the selected text element ---
  const nameField = doc.querySelector('[data-prop="name"]');
  assert(nameField !== null, "expected a name field in the properties panel");
  assert(nameField.value === "New Text", `expected default name 'New Text', got '${nameField.value}'`);
  console.log("PASS: properties panel reflects selected element");

  // --- Test 4: editing a property field updates the model + re-renders ---
  // New elements default to PX position (see baseNewElement) — the active
  // field is xPx, not xPct, until the %/PX toggle is switched by hand.
  const xField = doc.querySelector('[data-prop="xPx"]');
  xField.value = "25";
  xField.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(10);
  const movedEl = doc.querySelector("#canvas .ui-el");
  assert(movedEl.style.left === "calc(50% + 25px)", `expected left:calc(50% + 25px) after edit, got ${movedEl.style.left}`);
  console.log("PASS: editing X (PX) updates canvas position");

  // --- Test 5: anchor grid changes anchor + transform ---
  const anchorBtn = doc.querySelector('[data-anchor="top-left"]');
  anchorBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await wait(10);
  const elAfterAnchor = doc.querySelector("#canvas .ui-el");
  assert(elAfterAnchor.style.transform.includes("translate(0%, 0%)"), `expected top-left transform, got ${elAfterAnchor.style.transform}`);
  console.log("PASS: anchor grid updates transform");

  // --- Test 6: Add Image via file input (simulate a tiny PNG) ---
  const fileInput = doc.getElementById("file-image-input");
  const tinyPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const buf = Buffer.from(tinyPngBase64, "base64");
  const file = new window.File([buf], "test-sprite.png", { type: "image/png" });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(150); // FileReader + Image onload are async

  const layerItemsAfterImage = doc.querySelectorAll(".layer-item");
  assert(layerItemsAfterImage.length === 2, `expected 2 layers after adding image, got ${layerItemsAfterImage.length}`);
  console.log("PASS: Add Image creates a second layer");

  // --- Test 7: Save JSON produces schema-valid output ---
  const saveBtn = doc.getElementById("btn-save");
  saveBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  await wait(50);

  assert(downloadedJsonText !== null, "expected Save JSON to trigger a download");
  const parsed = JSON.parse(downloadedJsonText);

  assert(parsed.version === 1, "version should be 1");
  assert(typeof parsed.canvasWidth === "number", "canvasWidth should be a number");
  assert(typeof parsed.canvasHeight === "number", "canvasHeight should be a number");
  assert(Array.isArray(parsed.elements), "elements should be an array");
  assert(parsed.elements.length === 2, `expected 2 elements in saved JSON, got ${parsed.elements.length}`);

  const textEl = parsed.elements.find((e) => e.type === "text");
  const imgEl = parsed.elements.find((e) => e.type === "image");
  assert(textEl, "expected a text element in saved JSON");
  assert(imgEl, "expected an image element in saved JSON");
  assert(typeof imgEl.src === "string" && imgEl.src.startsWith("data:image/png;base64,"), "image element should have a base64 data URI src");

  const requiredFields = ["id", "type", "name", "xPct", "yPct", "widthPct", "heightPct", "anchor", "rotation", "opacity", "zIndex"];
  for (const el of parsed.elements) {
    for (const f of requiredFields) {
      assert(el[f] !== undefined, `element missing required field '${f}': ${JSON.stringify(el)}`);
    }
  }
  console.log("PASS: Save JSON produces a schema-valid layout file");
  console.log("\nSample output:\n" + JSON.stringify(parsed, null, 2).slice(0, 600) + "...\n");

  console.log("\nALL TESTS PASSED");
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("TEST ERROR:", err);
  process.exit(1);
});
