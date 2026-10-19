(function () {
  const originalFetch = window.fetch.bind(window);
  const OriginalXHR = window.XMLHttpRequest;

  const GD_PROXIES = [
    "https://gd-proxy.webdashers.workers.dev",
    "https://webdashers.webdashersdevelopement.workers.dev",
    "https://fallbackgdproxy.webdashers.workers.dev",
    "https://fallback2.webdashers.workers.dev"
  ];
  const BACKUP_APIS = ["https://api.sngdu.com/", "https://api.ixl.college/"];

  const HOST_CODES = {
    "boomlings.com": "b",
    "www.boomlings.com": "b",
    "robtopgames.org": "r",
    "www.robtopgames.org": "r",
    "audio.ngfiles.com": "n",
    "geometrydashfiles.b-cdn.net": "c"
  };

  const WORKER_HOST_RE = /^(?:gd-proxy\.webdashers|webdashers\.webdashersdevelopement|fallbackgdproxy\.webdashers|fallback2\.webdashers)\.workers\.dev\//;

  function resolveTargetUrl(input) {
    let str = String(input);
    let url;
    for (let i = 0; i < 5; i++) {
      if (WORKER_HOST_RE.test(str)) {
        str = "https://" + str;
      }
      try {
        url = new URL(str, location.href);
      } catch {
        return null;
      }
      if (url.pathname === "/__proxy" && url.searchParams.has("url")) {
        str = url.searchParams.get("url");
        continue;
      }
      if (BACKUP_APIS.some(api => new URL(api).hostname === url.hostname)) {
        let matched = false;
        for (const [host, code] of Object.entries(HOST_CODES)) {
          if (url.searchParams.has(code)) {
            str = "https://" + host + "/" + url.searchParams.get(code).replace(/^\/+/, "");
            matched = true;
            break;
          }
        }
        if (matched) continue;
        return null;
      }
      if (GD_PROXIES.some(p => new URL(p).hostname === url.hostname)) {
        if (url.pathname === "/audio-proxy" && url.searchParams.has("url")) {
          str = url.searchParams.get("url");
        } else {
          str = "https://www.boomlings.com/database" + url.pathname + url.search;
        }
        continue;
      }
      if (["proxy.corsfix.com", "corsproxy.io", "api.allorigins.win"].includes(url.hostname)) {
        str = url.searchParams.get("url") || url.search.slice(1);
        if (!/^https?:/i.test(str)) {
          try {
            str = decodeURIComponent(str);
          } catch {}
        }
        continue;
      }
      if (HOST_CODES[url.hostname]) {
        return url;
      }
      return null;
    }
    return null;
  }

  function buildProxyUrls(input) {
    const url = resolveTargetUrl(input);
    if (!url) return null;
    const code = HOST_CODES[url.hostname];
    const pathAndQuery = url.pathname.replace(/^\//, "") + url.search;
    const urls = [];
    if (code === "b" && url.pathname.startsWith("/database/")) {
      for (const proxy of GD_PROXIES) {
        urls.push(proxy + url.pathname.slice(9) + url.search);
      }
    }
    if (code === "n" || code === "c") {
      for (const proxy of GD_PROXIES) {
        urls.push(proxy + "/audio-proxy?url=" + encodeURIComponent(url.href));
      }
    }
    for (const api of BACKUP_APIS) {
      urls.push(api + "?" + code + "=" + encodeURIComponent(pathAndQuery));
    }
    return urls;
  }

  const isRetryableStatus = status => status === 429 || (status >= 500 && status <= 599);

  window.fetch = async function (input, init) {
    const urls = buildProxyUrls(input instanceof Request ? input.url : input);
    if (!urls) {
      return originalFetch(input, init);
    }
    const request = new Request(input, init);
    const outerSignal = request.signal;
    outerSignal.throwIfAborted();
    const body = request.body ? await request.clone().arrayBuffer() : null;
    for (let i = 0; i < urls.length; i++) {
      outerSignal.throwIfAborted();
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(new DOMException("Proxy timed out", "TimeoutError")),
        30000
      );
      try {
        const proxiedReq = new Request(urls[i], request.clone());
        const response = await originalFetch(new Request(proxiedReq, {
          body,
          signal: AbortSignal.any([outerSignal, controller.signal])
        }));
        if (isRetryableStatus(response.status) && i + 1 < urls.length) {
          response.body?.cancel().catch(() => {});
          continue;
        }
        return response;
      } catch (error) {
        if (outerSignal.aborted) throw outerSignal.reason || error;
        if (i + 1 === urls.length) throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  };

  function dispatchEvent(target, type, progressSource) {
    const event = progressSource && "loaded" in progressSource
      ? new ProgressEvent(type, {
          lengthComputable: progressSource.lengthComputable,
          loaded: progressSource.loaded,
          total: progressSource.total
        })
      : new Event(type);
    target.dispatchEvent(event);
  }

  class ProxyXHR extends EventTarget {
    constructor() {
      super();
      this.upload = new EventTarget();
      this._xhr = new OriginalXHR();
      this._state = 0;
      this._headers = [];
      this._sent = false;
      this._aborted = false;
      this._generation = 0;
    }
    open(method, url, async = true, user, password) {
      this._generation++;
      this._xhr.abort();
      this._urls = buildProxyUrls(url);
      this._args = [method, this._urls ? this._urls[0] : url, async, user, password];
      this._xhr = new OriginalXHR();
      this._xhr.open(...this._args);
      this._state = 1;
      this._headers = [];
      this._sent = false;
      this._aborted = false;
      this._mime = null;
      dispatchEvent(this, "readystatechange");
    }
    setRequestHeader(name, value) {
      this._xhr.setRequestHeader(name, value);
      this._headers.push([name, value]);
    }
    overrideMimeType(mime) {
      this._xhr.overrideMimeType(mime);
      this._mime = mime;
    }
    getResponseHeader(name) {
      return this._state >= 2 ? this._xhr.getResponseHeader(name) : null;
    }
    getAllResponseHeaders() {
      return this._state >= 2 ? this._xhr.getAllResponseHeaders() : "";
    }
    send(body = null) {
      if (this._state !== 1 || this._sent) {
        throw new DOMException("Invalid state", "InvalidStateError");
      }
      this._sent = true;
      const generation = this._generation;
      const savedProps = {
        responseType: this.responseType,
        withCredentials: this.withCredentials,
        timeout: this.timeout
      };
      let urlIndex = 0;
      const attempt = () => {
        if (this._aborted || generation !== this._generation) return;
        const xhr = this._xhr;
        const isProxied = !!this._urls;
        const isAsync = this._args[2] !== false;
        const bufferedUploadEvents = [];
        let bufferedProgress = null;
        if (isProxied && isAsync && !savedProps.timeout) {
          xhr.timeout = 30000;
        }
        const handleEvent = (eventType) => {
          if (this._aborted || generation !== this._generation) return;
          const shouldRetry = isProxied && (
            eventType === "error" ||
            eventType === "timeout" ||
            (eventType === "load" && isRetryableStatus(xhr.status))
          );
          if (shouldRetry && urlIndex + 1 < this._urls.length) {
            urlIndex++;
            this._xhr = new OriginalXHR();
            this._xhr.open(this._args[0], this._urls[urlIndex], ...this._args.slice(2));
            Object.assign(this._xhr, savedProps);
            if (this._mime) this._xhr.overrideMimeType(this._mime);
            for (const [name, value] of this._headers) {
              this._xhr.setRequestHeader(name, value);
            }
            return attempt();
          }
          if (isProxied) {
            for (const [type, evt] of bufferedUploadEvents) {
              dispatchEvent(this.upload, type, evt);
              if (this._aborted || generation !== this._generation) return;
            }
            if (eventType === "load") {
              this._state = 2;
              dispatchEvent(this, "readystatechange");
              if (this._aborted || generation !== this._generation) return;
              this._state = 3;
              dispatchEvent(this, "readystatechange");
              if (this._aborted || generation !== this._generation) return;
              if (bufferedProgress) {
                dispatchEvent(this, "progress", bufferedProgress);
              }
              if (this._aborted || generation !== this._generation) return;
            }
            this._sent = false;
            this._state = 4;
            dispatchEvent(this, "readystatechange");
            if (this._aborted || generation !== this._generation) return;
          }
          this._sent = false;
          dispatchEvent(this, eventType);
          dispatchEvent(this, "loadend");
        };
        xhr.onreadystatechange = () => {
          if (!isProxied && generation === this._generation) {
            this._state = xhr.readyState;
            dispatchEvent(this, "readystatechange");
          }
        };
        xhr.onprogress = (evt) => {
          if (isProxied) {
            bufferedProgress = evt;
          } else {
            dispatchEvent(this, "progress", evt);
          }
        };
        for (const type of ["load", "error", "timeout", "abort"]) {
          xhr["on" + type] = () => handleEvent(type);
        }
        for (const type of ["loadstart", "progress", "load", "error", "timeout", "abort", "loadend"]) {
          xhr.upload.addEventListener(type, (evt) => {
            if (isProxied) {
              const idx = bufferedUploadEvents.findIndex(e => e[0] === type);
              if (idx >= 0) bufferedUploadEvents[idx] = [type, evt];
              else bufferedUploadEvents.push([type, evt]);
            } else {
              dispatchEvent(this.upload, type, evt);
            }
          });
        }
        try {
          xhr.send(body);
        } catch (err) {
          if (!isProxied || !isAsync) {
            if (isProxied && urlIndex + 1 < this._urls.length && err.name === "NetworkError") {
              return handleEvent("error");
            }
            this._sent = false;
            throw err;
          }
          handleEvent("error");
        }
        if (!isAsync && xhr.readyState === 4 && this._sent) {
          handleEvent("load");
        }
      };
      dispatchEvent(this, "loadstart");
      attempt();
    }
    abort() {
      const wasSent = this._sent;
      this._aborted = true;
      this._generation++;
      this._xhr.abort();
      this._sent = false;
      if (wasSent) {
        this._state = 4;
        dispatchEvent(this, "readystatechange");
        dispatchEvent(this, "abort");
        dispatchEvent(this, "loadend");
      }
      this._state = 0;
    }
    get readyState() { return this._state; }
    get status()      { return this._state >= 2 && !this._aborted ? this._xhr.status : 0; }
    get statusText()  { return this._state >= 2 && !this._aborted ? this._xhr.statusText : ""; }
    get responseURL() { return this._state >= 2 && !this._aborted ? this._xhr.responseURL : ""; }
    get response() {
      if (this._state === 4 && !this._aborted) return this._xhr.response;
      if (this.responseType === "" || this.responseType === "text") return "";
      return null;
    }
    get responseText() {
      if (this.responseType !== "" && this.responseType !== "text") {
        return this._xhr.responseText;
      }
      return this._state >= 3 && !this._aborted ? this._xhr.responseText : "";
    }
    get responseXML() {
      return this._state === 4 && !this._aborted ? this._xhr.responseXML : null;
    }
  }

  for (const prop of ["timeout", "responseType", "withCredentials"]) {
    Object.defineProperty(ProxyXHR.prototype, prop, {
      get() { return this._xhr[prop]; },
      set(value) { this._xhr[prop] = value; }
    });
  }

  for (const [name, value] of Object.entries({
    UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4
  })) {
    Object.defineProperty(ProxyXHR, name, { value });
    Object.defineProperty(ProxyXHR.prototype, name, { value });
  }

  const EVENT_NAMES = [
    "readystatechange", "loadstart", "progress", "load",
    "error", "abort", "timeout", "loadend"
  ];

  function defineEventHandlers(target) {
    for (const type of EVENT_NAMES) {
      Object.defineProperty(target, "on" + type, {
        get() { return this["_on" + type] || null; },
        set(handler) {
          const prev = this["_on" + type];
          if (prev) this.removeEventListener(type, prev);
          this["_on" + type] = typeof handler === "function" ? handler : null;
          if (this["_on" + type]) this.addEventListener(type, handler);
        }
      });
    }
  }
  defineEventHandlers(ProxyXHR.prototype);

  window.XMLHttpRequest = class extends ProxyXHR {
    constructor() {
      super();
      const uploadProto = Object.create(EventTarget.prototype);
      defineEventHandlers(uploadProto);
      Object.setPrototypeOf(this.upload, uploadProto);
    }
  };
})();

var Module = {
  canvas: document.getElementById("canvas"),
  gdInputQueue: [],
  gdCursorPos: [0, 0],
  locateFile: name => name,
  print: () => {},
  printErr: msg => console.warn(msg),
  onAbort: err => startupError(err),
  onRuntimeInitialized: async function () {
    try {
      window.__gdRuntimeReady = true;
      if (Module._gd_log_set) Module._gd_log_set(0);
      Module.FS.chdir("/Resources");
      await restoreSaves();
      Module._gd_autosave_set(1);
      window.__gdInputReady = true;
      window.__gdAckFocus?.();
      window.__gdGameStarted = true;
      setInterval(requestSave, 10000);
      const bootPromise = Module._gd_boot();
      if (bootPromise?.catch) bootPromise.catch(startupError);
      function waitForFirstFrame() {
        if (Module._gd_frames_get && Module._gd_frames_get() > 0) {
          document.getElementById("loading-text").hidden = true;
          Module.canvas.focus({ preventScroll: true });
        } else {
          requestAnimationFrame(waitForFirstFrame);
        }
      }
      requestAnimationFrame(waitForFirstFrame);
    } catch (err) {
      startupError(err);
    }
  }
};

function requestSave() {
  if (window.__gdGameStarted && Module._gd_request_save) {
    try {
      Module._gd_request_save();
    } catch (err) {
      console.warn("Save request failed", err);
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) requestSave();
});
window.addEventListener("pagehide", requestSave);

function normalizeSavePath(raw) {
  const slashed = String(raw).replace(/\\/g, "/");
  const absolute =
    slashed.startsWith("/") ? slashed :
    /^(AppData|Resources)\//.test(slashed) ? "/" + slashed :
    "/Resources/" + slashed;
  const parts = [];
  for (const segment of absolute.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return "/" + parts.join("/");
}

function restoreSaves() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gdwasm_saves", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("files")) {
        request.result.createObjectStore("files");
      }
    };
    request.onerror   = () => reject(request.error);
    request.onblocked = () => console.warn("Waiting for saved progress database");
    request.onsuccess = () => {
      const db = request.result;
      let txn;
      let failure;
      try {
        txn = db.transaction("files", "readonly");
      } catch (err) {
        db.close();
        reject(err);
        return;
      }
      txn.oncomplete = () => {
        db.close();
        failure ? reject(failure) : resolve();
      };
      txn.onabort = txn.onerror = () => {
        db.close();
        reject(failure || txn.error || new Error("Save restoration failed"));
      };
      const cursorReq = txn.objectStore("files").openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        try {
          if (cursor.value != null) {
            const path = normalizeSavePath(cursor.key);
            const value = cursor.value;
            const bytes = ArrayBuffer.isView(value)
              ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
              : new Uint8Array(value);
            Module.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")) || "/");
            Module.FS.writeFile(path, bytes);
          }
          cursor.continue();
        } catch (err) {
          failure = err;
          txn.abort();
        }
      };
    };
  });
}

function startupError(err) {
  console.error(err);
  const el = document.getElementById("loading-text");
  el.hidden = false;
  el.textContent = "LOADING FAILED";
}

async function startGame() {
  const worker = new Worker(new URL("brotli-worker.js", document.baseURI), {
    type: "module"
  });
  let nextId = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.buffer);
  };
  worker.onerror = (event) => {
    for (const job of pending.values()) job.reject(new Error(event.message));
    pending.clear();
    worker.terminate();
  };
  function decompressInWorker(buffer) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, buffer }, [buffer]);
    });
  }
  let loadedBytes = 0;
  const loadingText = document.getElementById("loading-text");
  async function loadBrotliFile(baseUrl, parts, showProgress) {
    const chunks = [];
    let totalBytes = 0;
    for (let i = 1; i <= parts; i++) {
      const fileUrl = baseUrl + (parts > 1 ? ".part" + i : "");
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error(fileUrl + " HTTP " + response.status);
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.byteLength;
        if (showProgress) {
          loadedBytes += value.byteLength;
          loadingText.textContent =
            "LOADING... " + (loadedBytes / 1048576).toFixed(2) + " MB / 366.49 MB";
        }
      }
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    return decompressInWorker(combined.buffer);
  }
  const [wasmBuffer, dataBuffer, jsBuffer] = await Promise.all([
    loadBrotliFile("gd_web.wasm.br", 1,  true),
    loadBrotliFile("gd_web.data.br", 13, true),
    loadBrotliFile("gd_web.js.br",   1,  false)
  ]);
  worker.terminate();
  Module.wasmBinary = wasmBuffer;
  Module.getPreloadedPackage = () => dataBuffer;
  const scriptEl = document.createElement("script");
  scriptEl.textContent = new TextDecoder().decode(jsBuffer);
  document.body.appendChild(scriptEl);
}

startGame().catch(startupError);

window.__framed = window.self !== window.top;

window.addEventListener("message", function (event) {
  if (event.data === "gd-focus") {
    window.focus();
    const canvas = document.getElementById("canvas");
    try {
      canvas?.focus({ preventScroll: true });
    } catch {}
  }
  if (event.data === "gd-fullscreen") {
    const canvas = document.getElementById("canvas");
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (canvas) {
        const requestFs = canvas.requestFullscreen || canvas.webkitRequestFullscreen;
        if (requestFs) requestFs.call(canvas);
      }
    } catch {}
  }
});

document.addEventListener("click", function () {
  try {
    if (window.parent !== window) window.parent.postMessage("gd-click", "*");
  } catch {}
});

(function () {
  const canvas = document.getElementById("canvas");

  const EVT_MOUSE_MOVE   = 512;
  const EVT_MOUSE_DOWN   = 513;
  const EVT_MOUSE_UP     = 514;
  const EVT_RIGHT_DOWN   = 516;
  const EVT_RIGHT_UP     = 517;
  const EVT_MIDDLE_DOWN  = 519;
  const EVT_MIDDLE_UP    = 520;
  const EVT_SCROLL_VERT  = 522;
  const EVT_SCROLL_HORIZ = 526;

  function isInputReady() {
    return window.__gdInputReady === true;
  }

  function isOnCanvas(event) {
    if (!isInputReady() || !canvas) return false;
    if (event.target?.closest?.("#console, #start, #loadFly, a, button, input, textarea, select")) {
      return false;
    }
    const rect = canvas.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX < rect.right &&
           event.clientY >= rect.top  && event.clientY < rect.bottom;
  }

  function toLogicalCoords(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1919, Math.round((event.clientX - rect.left) * 1920 / rect.width)));
    const y = Math.max(0, Math.min(1079, Math.round((event.clientY - rect.top)  * 1080 / rect.height)));
    Module.gdCursorPos[0] = x;
    Module.gdCursorPos[1] = y;
    return (x & 0xFFFF) | ((y & 0xFFFF) << 16);
  }

  function pushInput(eventType, arg1, arg2) {
    Module.gdInputQueue.push([eventType | 0, arg1 | 0, arg2 | 0]);
  }

  let focusAcked = false;
  function ackFocus() {
    if (focusAcked) return;
    focusAcked = true;
    pushInput(6, 1, 0);
    pushInput(7, 0, 0);
    pushInput(28, 1, 0);
  }
  window.__gdAckFocus = ackFocus;

  let pressedButtonsMask = 0;

  window.addEventListener("mousedown", function (event) {
    if (!isOnCanvas(event)) return;
    console.log("[page] mousedown btn=" + event.button +
                " lp=0x" + toLogicalCoords(event).toString(16));
    const downEvt =
      event.button === 2 ? EVT_RIGHT_DOWN :
      event.button === 1 ? EVT_MIDDLE_DOWN :
                           EVT_MOUSE_DOWN;
    const sdlButton =
      event.button === 2 ? 2 :
      event.button === 1 ? 16 :
                           1;
    pressedButtonsMask |= 1 << event.button;
    pushInput(downEvt, sdlButton, toLogicalCoords(event));
    event.preventDefault();
  });

  window.addEventListener("mouseup", function (event) {
    if (!isInputReady()) return;
    pressedButtonsMask &= ~(1 << event.button);
    const upEvt =
      event.button === 2 ? EVT_RIGHT_UP :
      event.button === 1 ? EVT_MIDDLE_UP :
                           EVT_MOUSE_UP;
    pushInput(upEvt, 0, toLogicalCoords(event));
    pushInput(EVT_MOUSE_MOVE, 0, toLogicalCoords(event));
    if (event.target === canvas) event.preventDefault();
  });

  window.addEventListener("blur", function () {
    if (!isInputReady() || !pressedButtonsMask) return;
    for (let button = 0; button < 3; ++button) {
      if (pressedButtonsMask & (1 << button)) {
        const upEvt =
          button === 2 ? EVT_RIGHT_UP :
          button === 1 ? EVT_MIDDLE_UP :
                         EVT_MOUSE_UP;
        pushInput(upEvt, 0, (Module.gdCursorPos[0] & 0xFFFF) | (Module.gdCursorPos[1] << 16));
      }
    }
    pressedButtonsMask = 0;
  });

  window.addEventListener("mousemove", function (event) {
    if (!isInputReady()) return;
    const queue = Module.gdInputQueue;
    const leftHeld = (event.buttons & 1) ? 1 : 0;
    const coords = toLogicalCoords(event);
    if (queue.length && queue[queue.length - 1][0] === EVT_MOUSE_MOVE) {
      queue[queue.length - 1] = [EVT_MOUSE_MOVE, leftHeld, coords];
    } else {
      queue.push([EVT_MOUSE_MOVE, leftHeld, coords]);
    }
  });

  window.addEventListener("wheel", function (event) {
    if (!isOnCanvas(event)) return;
    const coords = toLogicalCoords(event);
    const deltaY = -event.deltaY;
    const deltaX = event.deltaX;
    if (Math.abs(deltaY) >= Math.abs(deltaX)) {
      const amount = deltaY > 0 ? 120 : -120;
      pushInput(EVT_SCROLL_VERT, (amount & 0xFFFF) << 16, coords);
    } else {
      const amount = deltaX > 0 ? -120 : 120;
      pushInput(EVT_SCROLL_HORIZ, (amount & 0xFFFF) << 16, coords);
    }
    event.preventDefault();
  }, { passive: false });

  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.tabIndex = 0;
  canvas.addEventListener("mousedown", () => canvas.focus());

  let rawKeyLogCount = 0;
  document.addEventListener("keydown", function (event) {
    if (rawKeyLogCount++ < 10) {
      console.log("[page] raw keydown code=" + event.code + " key=" + event.key);
    }
  }, true);

  const VK_CODES = {
    Escape: 27, Space: 32, Enter: 13, Backspace: 8, Tab: 9,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68,
    KeyQ: 81, KeyE: 69, KeyR: 82, KeyF: 70, KeyP: 80
  };

  const SDL_SCANCODES = {
    Escape: 1, Space: 57, Enter: 28, Backspace: 14, Tab: 15,
    ArrowLeft: 75, ArrowUp: 72, ArrowRight: 77, ArrowDown: 80,
    KeyW: 17, KeyA: 30, KeyS: 31, KeyD: 32,
    KeyQ: 16, KeyE: 18, KeyR: 19, KeyF: 33, KeyP: 25
  };

  const ARROW_KEYS = { ArrowLeft: 1, ArrowUp: 1, ArrowRight: 1, ArrowDown: 1 };

  Module.gdKeyState = new Uint8Array(256);

  let charLogCount = 0;
  let keyLogCount = 0;

  function handleKey(event, isDown) {
    if (!isInputReady()) return;
    try {
      if (window.getSelection && String(window.getSelection()) !== "") return;
    } catch {}
    const vk = VK_CODES[event.code] || event.keyCode || 0;
    if (isDown) {
      let charCode = 0;
      if (event.key && event.key.length === 1) {
        charCode = event.key.charCodeAt(0);
      } else if (event.code === "Backspace") {
        charCode = 8;
      } else if (event.code === "Enter") {
        charCode = 13;
      }
      if (charCode) {
        let packed = ((SDL_SCANCODES[event.code] || 0) << 16) | 1;
        if (ARROW_KEYS[event.code]) packed |= 0x1000000;
        if (charLogCount++ < 12) {
          console.log("[page] char=0x" + charCode.toString(16) + " code=" + event.code);
        }
        pushInput(258, charCode, packed);
      }
    }
    if (!vk) return;
    if (keyLogCount++ < 8) {
      console.log("[page] key " + (isDown ? "down" : "up") +
                  " code=" + event.code + " vk=0x" + vk.toString(16));
    }
    Module.gdKeyState[vk & 255] = isDown ? 1 : 0;
    let packed = (SDL_SCANCODES[event.code] || 0) << 16 | 1;
    if (ARROW_KEYS[event.code]) packed |= 0x1000000;
    if (!isDown) packed |= -1073741824;
    pushInput(isDown ? 256 : 257, vk, packed);
    if (event.code === "Space" || event.code === "ArrowUp" || event.code === "ArrowDown") {
      event.preventDefault();
    }
  }

  window.addEventListener("keydown", e => handleKey(e, true));
  window.addEventListener("keyup",   e => handleKey(e, false));
})();

(function () {
  function reportRuntimeError(err) {
    console.error(err);
  }
  const canvas = document.getElementById("canvas");
  function toLogicalCoords(touch) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1919, Math.round((touch.clientX - rect.left) * 1920 / rect.width)));
    const y = Math.max(0, Math.min(1079, Math.round((touch.clientY - rect.top)  * 1080 / rect.height)));
    try {
      Module.gdCursorPos[0] = x;
      Module.gdCursorPos[1] = y;
    } catch {}
    return (x & 0xFFFF) | ((y & 0xFFFF) << 16);
  }
  function shouldHandleTouch(event) {
    if (window.__gdInputReady !== true) return false;
    if (event.target?.closest?.("#console,#start,#loadFly,button,input,textarea,select")) {
      return false;
    }
    return true;
  }
  if (canvas) {
    canvas.addEventListener("touchstart", function (event) {
      if (!shouldHandleTouch(event)) return;
      for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i];
        try {
          Module.gdInputQueue.push([513, 1, toLogicalCoords(touch)]);
        } catch {}
      }
      try { canvas.focus(); } catch {}
      event.preventDefault();
    }, { passive: false });
    canvas.addEventListener("touchmove", function (event) {
      if (!shouldHandleTouch(event)) return;
      event.preventDefault();
    }, { passive: false });
    canvas.addEventListener("touchend", function (event) {
      if (window.__gdInputReady !== true) return;
      for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i];
        try {
          Module.gdInputQueue.push([514, 0, toLogicalCoords(touch)]);
          Module.gdInputQueue.push([512, 0, toLogicalCoords(touch)]);
        } catch {}
      }
      event.preventDefault();
    }, { passive: false });
    canvas.addEventListener("touchcancel", function (event) {
      if (window.__gdInputReady !== true) return;
      try {
        Module.gdInputQueue.push([
          514, 0,
          (Module.gdCursorPos[0] & 0xFFFF) | (Module.gdCursorPos[1] << 16)
        ]);
      } catch {}
      event.preventDefault();
    }, { passive: false });
  }
  window.addEventListener("error", function (event) {
    if (event?.message && /JSPI|WebAssembly|wasm|memory/i.test(String(event.message))) {
      reportRuntimeError("Runtime error: " + event.message);
    }
  });
})();