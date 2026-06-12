// Loads public/app.js under a minimal DOM/browser shim to detect any error thrown
// during top-level module evaluation — the failure mode that leaves every button
// dead (listeners are attached only after the top-level render runs).

const noop = () => {};

function fakeElement(id) {
  const el = {
    id,
    _value: "",
    textContent: "",
    className: "",
    title: "",
    style: new Proxy({}, { get: () => "", set: () => true }),
    dataset: {},
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    children: [],
    get value() { return this._value; },
    set value(v) { this._value = v; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html ?? ""; },
    append: noop,
    replaceChildren: noop,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    setAttribute: noop,
    getContext: () => null,
    click: noop
  };
  return el;
}

const elementCache = new Map();
const getById = (sel) => {
  const key = sel.replace(/^#/, "");
  if (!elementCache.has(key)) elementCache.set(key, fakeElement(key));
  return elementCache.get(key);
};

globalThis.document = {
  querySelector: (sel) => getById(sel),
  querySelectorAll: () => [],
  createElement: (tag) => fakeElement(`<${tag}>`),
  body: fakeElement("body")
};

globalThis.window = globalThis;
if (!globalThis.navigator || !globalThis.navigator.hardwareConcurrency) {
  Object.defineProperty(globalThis, "navigator", {
    value: { hardwareConcurrency: 8 },
    configurable: true
  });
}
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };
globalThis.location = { search: "?adapter=sim", port: "4173", href: "http://localhost:4173/" };
globalThis.localStorage = {
  _s: new Map(),
  getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
  setItem(k, v) { this._s.set(k, String(v)); },
  removeItem(k) { this._s.delete(k); }
};
globalThis.requestAnimationFrame = noop;
globalThis.cancelAnimationFrame = noop;
globalThis.setInterval = () => 0; // don't actually start the loop
globalThis.Worker = class { postMessage() {} terminate() {} };
globalThis.Blob = class {};
globalThis.URL = { createObjectURL: () => "blob:", revokeObjectURL: noop };
globalThis.fetch = () => Promise.reject(new Error("no bridge in harness")); // forces sim fallback

try {
  await import("../public/app.js");
  console.log("OK: app.js evaluated to completion — top-level listeners would attach.");
  process.exit(0);
} catch (error) {
  console.error("THROW during app.js load (this kills all clicks):");
  console.error(error);
  process.exit(1);
}
