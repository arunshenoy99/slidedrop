// Streams the current presentation PDF from R2 at a same-origin path (/deck).
// Swap the object in R2 (key: "deck.pdf") to publish a new deck — no redeploy.
//
// Binding required (set in Cloudflare Pages → Settings → Functions → R2 bindings,
// and in wrangler.toml for local dev): PDF_BUCKET -> your R2 bucket.

const OBJECT_KEY = "deck.pdf";

// Monthly updates only, so a short edge cache is plenty. ETag handles freshness:
// if the file is unchanged the browser/edge revalidates cheaply; when you upload a
// new deck the ETag changes and clients pull the new bytes automatically.
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=86400";

function notFound() {
  return new Response("Presentation not found. Upload a PDF to R2 as 'deck.pdf'.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function parseRange(header, size) {
  // Only single-range "bytes=start-end" is handled (all PDF.js needs).
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m) return null;
  let [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;

  let start, end;
  if (startStr === "") {
    // suffix range: last N bytes
    const n = parseInt(endStr, 10);
    if (Number.isNaN(n)) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : parseInt(endStr, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

export async function onRequest(context) {
  const { request, env, waitUntil } = context;

  if (!env.PDF_BUCKET) {
    return new Response("R2 binding 'PDF_BUCKET' is not configured.", { status: 500 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  // Edge cache: a plain full GET is served straight from Cloudflare's cache, so a flood
  // of requests collapses to ~1 R2 read per cache TTL (see CACHE_CONTROL) — this shields
  // R2 ops and Function CPU from abuse/bursts. Range & conditional requests skip it.
  const cache = caches.default;
  const cacheable =
    request.method === "GET" &&
    !request.headers.get("range") &&
    !request.headers.get("if-none-match");
  if (cacheable) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  // Cheap metadata lookup first (gives us size + etag without the body).
  const head = await env.PDF_BUCKET.head(OBJECT_KEY);
  if (!head) return notFound();

  const size = head.size;
  const etag = head.httpEtag; // already quoted
  const baseHeaders = {
    "content-type": "application/pdf",
    "accept-ranges": "bytes",
    "cache-control": CACHE_CONTROL,
    etag,
  };

  // Conditional request — let clients reuse their cached copy.
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: { ...baseHeaders, "content-length": String(size) } });
  }

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { ...baseHeaders, "content-range": `bytes */${size}` },
      });
    }
    const length = range.end - range.start + 1;
    const obj = await env.PDF_BUCKET.get(OBJECT_KEY, {
      range: { offset: range.start, length },
    });
    if (!obj) return notFound();
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "content-length": String(length),
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }

  const obj = await env.PDF_BUCKET.get(OBJECT_KEY);
  if (!obj) return notFound();
  const response = new Response(obj.body, {
    status: 200,
    headers: { ...baseHeaders, "content-length": String(size) },
  });
  // Populate the edge cache (TTL comes from Cache-Control) without delaying the response.
  if (cacheable) waitUntil(cache.put(request, response.clone()));
  return response;
}
