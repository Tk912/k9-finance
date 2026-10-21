// K9 bridge: the app was first built as a claude.ai artifact and calls
// claude.use("mcp") / claude.use("sample"). On our own server those calls are
// routed to the server's API, which holds the Google and Claude credentials.
(function () {
  function codedError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  async function api(path, opts) {
    const resp = await fetch(path, Object.assign({ credentials: "same-origin" }, opts || {}));
    if (resp.status === 401) {
      location.href = "/login";
      throw codedError("session_expired");
    }
    let body = null;
    try { body = await resp.json(); } catch (e) { body = null; }
    if (!resp.ok) {
      throw codedError((body && body.code) || "server_error", (body && body.message) || ("שגיאת שרת " + resp.status));
    }
    return body;
  }

  // Shrinks the image to max 1600px and returns JPEG base64
  async function fileToJpegBase64(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  const mcp = {
    async callTool(server, tool, args) {
      if (server === "Google Drive" && tool === "download_file_content") {
        const body = await api("/api/sheet");
        return { payload: { content: body.content } };
      }
      throw codedError("not_supported", "הפעולה " + tool + " לא נתמכת בשרת");
    }
  };

  let limitsCache = null;
  async function getLimits() {
    if (!limitsCache) limitsCache = await api("/api/limits");
    return limitsCache;
  }

  const sample = {
    async limits() {
      const l = await getLimits();
      return l.scan ? { images: { mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/heic"], maxInputBytes: 25 * 1024 * 1024 } } : null;
    },
    async json(prompt, opts) {
      opts = opts || {};
      const payload = { prompt: String(prompt) };
      if (opts.images) {
        const file = Array.isArray(opts.images) ? opts.images[0] : opts.images;
        try {
          payload.image = { data: await fileToJpegBase64(file), mediaType: "image/jpeg" };
        } catch (e) {
          throw codedError("image_rejected");
        }
      }
      try {
        const body = await api("/api/sample", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: opts.signal
        });
        return body.result;
      } catch (e) {
        if (e && e.name === "AbortError") throw codedError("cancelled");
        throw e;
      }
    }
  };

  window.claude = {
    async use(name) {
      if (name === "mcp") return mcp;
      if (name === "sample") {
        try {
          const l = await getLimits();
          return l.scan ? sample : null;
        } catch (e) {
          return null;
        }
      }
      return null;
    }
  };
})();
