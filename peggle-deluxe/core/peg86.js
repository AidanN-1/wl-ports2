(() => {
  "use strict";

  const CORE = new URL(".", document.currentScript.src).href;
  const SLOT = document.body.dataset.slot;
  const TITLE = document.title;
  const DB_NAME = "peg86";
  const STORE = "saves";
  const PART_DB = "peg86-parts";
  const PART_STORE = "parts";
  const touch = matchMedia("(pointer: coarse)").matches;

  /* ================== SPLIT FILES ==================
     Both payloads are over jsdelivr's 20 MB per-file limit, so tools/split.py
     stores them as .part0, .part1, ... and the loader stitches them back
     together. Sizes and leading bytes are the values recorded at split time;
     the check below is what catches a CDN error page arriving with a 200. */
  const SPLITS = {
    "state.bin": { base: "state.bin", parts: 16, size: 318096748, head: "76867686060000006cc5f512f3cb9b01" },
    "reactos.img": { base: CORE + "reactos.img", parts: 35, size: 734003200, head: "fafc31c08ed08ed8bd007c8d66e0fbb8" },
  };
  // tools/split.py cuts at 20 MB, so every part but the last is exactly this.
  const CHUNK = 20971520;

  const el = (tag, props = {}, html = "") => {
    const node = Object.assign(document.createElement(tag), props);
    if (html) node.innerHTML = html;
    return node;
  };

  const screen = document.getElementById("screen");
  const canvas = screen.querySelector("canvas");

  const loader = document.getElementById("loader-screen");
  const loaderTitle = loader.querySelector("h1");
  const statusNodes = {
    "state.bin": document.getElementById("status-state"),
    "reactos.img": document.getElementById("status-img"),
  };

  const toast = el("div", { id: "toast", className: "hidden" });

  const typer = el("div", { id: "typer" });
  const typerInput = el("input", {
    type: "text",
    placeholder: "type here, enter to send",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: false,
  });
  typerInput.setAttribute("autocorrect", "off");
  typer.append(typerInput);

  const ffwd = el("button", { id: "ffwd", type: "button", textContent: "right click" });

  const fileInput = el("input", { type: "file", accept: ".peg86", hidden: true });

  const bar = el("div", { id: "bar", className: "hidden" });
  const tool = (label, handler) => {
    const b = el("button", { type: "button", textContent: label });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      handler(b);
    });
    return b;
  };

  const fsButton = tool("fullscreen", toggleFullscreen);
  bar.append(
    fsButton,
    tool("type", toggleTyper),
    tool("save", () => saveProgress(true)),
    tool("export", exportSave),
    tool("import", () => fileInput.click()),
    tool("reset", resetSave),
  );

  document.body.append(toast, typer, ffwd, fileInput, bar);

  let toastTimer = 0;
  function notify(text, { hold = false } = {}) {
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.classList.remove("hidden");
    if (!hold) toastTimer = setTimeout(() => toast.classList.add("hidden"), 2400);
  }

  function setStatus(key, text, done) {
    const node = statusNodes[key];
    if (!node) return;
    node.textContent = text;
    node.classList.remove("pending");
    node.style.color = done ? "#00e676" : "#ffeb3b";
  }

  function setTitle(text) {
    loaderTitle.textContent = text;
  }

  function failLoader(text) {
    loader.classList.add("error");
    loaderTitle.textContent = text;
    loaderTitle.style.color = "#ff4444";
    loaderTitle.style.animation = "none";
  }

  const mb = (n) => (n / 1048576).toFixed(0);
  const nextFrame = () =>
    new Promise((r) => {
      if (document.hidden) return setTimeout(r, 0);
      requestAnimationFrame(() => setTimeout(r, 0));
      setTimeout(r, 100);
    });

  let barTimer = 0;
  let ready = false;
  function showBar() {
    if (!ready || document.pointerLockElement) return;
    bar.classList.remove("hidden");
    clearTimeout(barTimer);
    barTimer = setTimeout(() => {
      if (!bar.matches(":hover")) bar.classList.add("hidden");
    }, 2600);
  }
  addEventListener("pointermove", showBar, { passive: true });
  addEventListener("pointerdown", showBar, { passive: true });
  bar.addEventListener("mouseleave", showBar);

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement;
  }

  function toggleFullscreen() {
    if (fullscreenElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request) return notify("fullscreen not supported");
    Promise.resolve(request.call(root, { navigationUI: "hide" }))
      .then(() => navigator.keyboard?.lock?.(["Escape"]).catch(() => {}))
      .catch(() => notify("fullscreen blocked"));
  }

  function syncFullscreen() {
    const on = Boolean(fullscreenElement());
    fsButton.textContent = on ? "exit fullscreen" : "fullscreen";
  }
  document.addEventListener("fullscreenchange", syncFullscreen);
  document.addEventListener("webkitfullscreenchange", syncFullscreen);

  function toggleTyper() {
    const open = typer.classList.toggle("open");
    if (open) typerInput.focus();
    else typerInput.blur();
  }

  /* ================== SPLIT LOADER ==================
     The Cache API refuses these payloads: cache.put on a single 318 MB or
     734 MB Response comes back QuotaExceededError, so nothing is ever reused
     and every visit re-downloads about a gigabyte. IndexedDB is given one
     record per part instead - 51 records of at most 20,971,520 bytes, each
     written in its own transaction so no single transaction has to hold the
     whole file - and the parts are stored as Blobs rather than ArrayBuffers so
     the browser can keep them on disk and read them back lazily. */

  function getParts(file, start, end) {
    const parts = [];
    for (let i = start; i <= end; i++) parts.push(file + ".part" + i);
    return parts;
  }

  async function checkSplit(name, blob) {
    const spec = SPLITS[name];
    if (blob.size !== spec.size) {
      throw new Error(name + " is " + blob.size + " bytes, expected " + spec.size);
    }
    const head = await blob.slice(0, 16).arrayBuffer();
    const hex = [...new Uint8Array(head)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== spec.head) throw new Error(name + " failed its header check");
    return blob;
  }

  const partKey = (name, i) => name + "\u0000" + i;
  // Written last, and only once every part is stored and verified, so its
  // presence is the marker that the set is complete.
  const manifestKey = (name) => name + "\u0000manifest";

  let partDbPromise;
  function partDb() {
    partDbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(PART_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(PART_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return partDbPromise;
  }

  async function partGet(key) {
    const store = (await partDb()).transaction(PART_STORE, "readonly").objectStore(PART_STORE);
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  // Resolves on transaction.oncomplete, not on the request's own onsuccess.
  // A request can succeed and still be discarded when the transaction later
  // aborts, which is exactly what a quota failure looks like: the puts report
  // success, the bytes never land, and the manifest then claims a complete set
  // that is only partly there. Waiting for oncomplete makes the abort surface
  // here instead.
  function partPut(key, value) {
    return (async () => {
      const db = await partDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(PART_STORE, "readwrite");
        tx.objectStore(PART_STORE).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("part write failed"));
        tx.onabort = () => reject(tx.error || new Error("part write aborted"));
      });
    })();
  }

  function partClear(name) {
    return (async () => {
      const db = await partDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(PART_STORE, "readwrite");
        // Every key for this file shares the "name\0" prefix.
        tx.objectStore(PART_STORE).delete(IDBKeyRange.bound(name + "\u0000", name + "\u0000\uffff"));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    })();
  }

  async function storedParts(spec) {
    let manifest;
    try {
      manifest = await partGet(manifestKey(spec.base));
    } catch {
      return null;
    }
    // A manifest that disagrees with the current split means the file was
    // re-split since, so the stored chunks are the wrong shape.
    if (!manifest || manifest.parts !== spec.parts || manifest.size !== spec.size) return null;

    const blobs = [];
    for (let i = 0; i < spec.parts; i++) {
      let blob;
      try {
        blob = await partGet(partKey(spec.base, i));
      } catch {
        return null;
      }
      // Every part must be present, and exactly the size it was stored at. A
      // manifest alone is not proof the parts survived: a transaction can
      // abort after its request reported success, and storage pressure can
      // drop records. Re-check the sizes so a short set is refetched instead of
      // being merged into a truncated image.
      const expected = i < spec.parts - 1 ? CHUNK : spec.size - CHUNK * (spec.parts - 1);
      if (!(blob instanceof Blob) || blob.size !== expected) return null;
      blobs.push(blob);
    }
    return blobs;
  }

  // Each part is 20 MB, so a single dropped connection mid-file would cost the
  // visitor the whole download. Retry with a growing delay and a cap on the
  // total time spent on one part, so a genuinely missing part still surfaces as
  // an error instead of hanging the loader forever.
  const PART_ATTEMPTS = 4;

  async function fetchPart(url, expectedSize) {
    let lastErr;
    for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        // A proxy or CDN error page can arrive with a 200, so confirm the
        // part is the length it was split at before treating it as good.
        if (expectedSize !== undefined && blob.size !== expectedSize) {
          throw new Error("got " + blob.size + " bytes, expected " + expectedSize);
        }
        return blob;
      } catch (err) {
        lastErr = err;
        if (attempt === PART_ATTEMPTS) break;
        // Offline or DNS failures never succeed on a tight loop; give the
        // network a real chance to come back.
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw new Error("Failed to fetch " + url + " after " + PART_ATTEMPTS + " tries: " + lastErr.message);
  }

  let fetchQueue = Promise.resolve();
  function fetchQueued(url, expectedSize) {
    const next = fetchQueue.then(() => fetchPart(url, expectedSize));
    fetchQueue = next.catch(() => {});
    return next;
  }

  async function mergeSplit(name) {
    const spec = SPLITS[name];
    const urls = getParts(spec.base, 0, spec.parts - 1);

    const stored = await storedParts(spec);
    if (stored) {
      try {
        const blob = await checkSplit(name, new Blob(stored));
        setStatus(name, "done ✓ (cached)", true);
        return blob;
      } catch {
        await partClear(spec.base).catch(() => {});
      }
    }

    const blobs = [];
    let loaded = 0;
    for (let i = 0; i < urls.length; i++) {
      const expected = i < urls.length - 1 ? CHUNK : spec.size - CHUNK * (urls.length - 1);
      const chunk = await fetchQueued(urls[i], expected);
      blobs.push(chunk);
      loaded += chunk.size;
      setStatus(name, "loading " + mb(loaded) + "/" + mb(spec.size) + " MB");
    }

    const merged = await checkSplit(name, new Blob(blobs));
    setStatus(name, "done ✓", true);

    // Storing parts is an optimisation, so a quota failure must not stop the
    // game: the merged blob is already in hand either way.
    try {
      await partClear(spec.base);
      for (let i = 0; i < blobs.length; i++) await partPut(partKey(spec.base, i), blobs[i]);
      await partPut(manifestKey(spec.base), { parts: spec.parts, size: spec.size });
    } catch (err) {
      console.warn("could not store " + name + " parts", err);
    }
    return merged;
  }

  /* ================== STORAGE ================== */

  const hasGzip = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

  const pipe = (blob, Stream) => new Response(blob.stream().pipeThrough(new Stream("gzip")));
  const gzip = async (buffer) => (hasGzip ? pipe(new Blob([buffer]), CompressionStream).blob() : new Blob([buffer]));
  const gunzip = async (blob) => (hasGzip ? pipe(blob, DecompressionStream).arrayBuffer() : blob.arrayBuffer());

  let dbPromise;
  function db() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idb(mode, action) {
    const store = (await db()).transaction(STORE, mode).objectStore(STORE);
    return new Promise((resolve, reject) => {
      const req = action(store);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  const readSave = () => idb("readonly", (s) => s.get(SLOT));
  const writeSave = (blob) => idb("readwrite", (s) => s.put(blob, SLOT));
  const deleteSave = () => idb("readwrite", (s) => s.delete(SLOT));

  /* ================== EMULATOR ================== */

  let emulator = null;

  typerInput.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return toggleTyper();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = typerInput.value;
    typerInput.value = "";
    for (const char of text) {
      emulator.keyboard_send_text(char);
      await new Promise((r) => setTimeout(r, 40));
    }
    emulator.keyboard_send_scancodes([0x1c, 0x9c]);
  });

  const release = () => emulator.bus.send("mouse-click", [false, false, false]);
  ffwd.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    ffwd.classList.add("held");
    emulator.bus.send("mouse-click", [false, false, true]);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    ffwd.addEventListener(type, () => {
      ffwd.classList.remove("held");
      release();
    });
  }
  ffwd.addEventListener("contextmenu", (e) => e.preventDefault());
  screen.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("click", () => {
    if (!ready || touch || document.pointerLockElement) return;
    const lock = canvas.requestPointerLock({ unadjustedMovement: true });
    if (lock && lock.catch) lock.catch(() => canvas.requestPointerLock());
  });

  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement) {
      bar.classList.add("hidden");
      if (typer.classList.contains("open")) toggleTyper();
    } else {
      showBar();
    }
  });

  /* v86 picks its reader in Da(): a File buffer with async:true becomes Ca,
     which reads through file.slice() on demand. Passing url: instead would go
     through ranged XHR, and Range is a forbidden header on blob: URLs. */
  function createEmulator(disk) {
    return new V86({
      wasm_path: CORE + "v86.wasm?v=5",
      bios: { url: CORE + "seabios.bin" },
      vga_bios: { url: CORE + "vgabios.bin" },
      memory_size: 512 * 1024 * 1024,
      vga_memory_size: 8 * 1024 * 1024,
      screen_container: screen,
      hda: { buffer: disk, async: true },
      net_device: { type: "virtio", relay_url: "" },
      autostart: false,
    });
  }

  async function boot(saved, stateBlob) {
    try {
      let state;
      if (saved) {
        setTitle("loading save");
        await nextFrame();
        try {
          state = await gunzip(saved);
        } catch {
          notify("save was broken, starting over");
        }
      }
      if (!state) {
        setTitle("starting");
        await nextFrame();
        state = await stateBlob.arrayBuffer();
      }
      setTitle("starting");
      await nextFrame();
      await emulator.restore_state(state);
      emulator.run();
      ready = true;
      loader.classList.add("done");
      if (touch) ffwd.classList.add("show");
      if (touch) notify("hold the button for right click");
    } catch (err) {
      console.error(err);
      failLoader(err?.message || "failed to load");
    }
  }

  async function start() {
    try {
      let saved = null;
      try {
        saved = await readSave();
      } catch {}

      const imgPromise = mergeSplit("reactos.img");
      // A save already holds the whole machine, so the 318 MB state blob is
      // only needed when there is nothing to restore from.
      const statePromise = saved ? null : mergeSplit("state.bin");
      const [disk, stateBlob] = await Promise.all([imgPromise, statePromise]);
      if (!stateBlob) setStatus("state.bin", "skipped (using save)", true);

      emulator = createEmulator(new File([disk], "reactos.img"));
      emulator.add_listener("download-progress", (e) => {
        if (e.lengthComputable) setTitle("loading " + e.loaded + "/" + e.total);
      });
      emulator.add_listener("emulator-loaded", () => boot(saved, stateBlob));
    } catch (err) {
      console.error(err);
      failLoader(err?.message || "failed to load");
    }
  }

  let saving = null;
  function saveProgress(loud) {
    if (!ready) return Promise.resolve();
    if (saving) return saving;
    saving = (async () => {
      try {
        if (loud) notify("saving", { hold: true });
        await nextFrame();
        await writeSave(await gzip(await emulator.save_state()));
        if (loud) notify("saved");
      } catch (err) {
        console.error(err);
        notify(err?.name === "QuotaExceededError" ? "storage full, use export" : "save failed");
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  async function exportSave() {
    if (!ready) return;
    try {
      notify("exporting", { hold: true });
      await nextFrame();
      const blob = await gzip(await emulator.save_state());
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: SLOT + ".peg86" });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      notify("exported");
    } catch (err) {
      console.error(err);
      notify("export failed");
    }
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file || !ready) return;
    try {
      notify("importing", { hold: true });
      await nextFrame();
      await emulator.restore_state(await gunzip(file));
      await writeSave(file);
      notify("imported");
    } catch (err) {
      console.error(err);
      notify("not a valid save");
    }
  });

  async function resetSave() {
    if (!confirm("reset " + TITLE + " progress?")) return;
    ready = false;
    try {
      await deleteSave();
    } catch {}
    location.reload();
  }

  addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProgress(true);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveProgress(false);
  });
  addEventListener("pagehide", () => saveProgress(false));

  navigator.storage?.persist?.().catch(() => {});
  start();
})();