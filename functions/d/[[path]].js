// Streams a presentation PDF from R2 at /d/<path>, where <path> is one or more name
// segments that map to the object "<path>.pdf". R2 keys are flat strings, so a "/" in the
// path is just a key prefix — this is how decks can be grouped into folders:
//   /                 -> /d/deck          -> R2 "deck.pdf"          (default deck)
//   /meetup           -> /d/meetup        -> R2 "meetup.pdf"
//   /wpblr/meetup     -> /d/wpblr/meetup  -> R2 "wpblr/meetup.pdf"
// Publish by uploading "<path>.pdf" to R2 (see scripts/publish.mjs) — no redeploy.
//
// Binding required (Cloudflare Pages → Settings → Functions → R2 bindings, and in
// wrangler.toml for local dev): PDF_BUCKET -> your R2 bucket.

// SECURITY: the object key is request-derived, so the path is the trust boundary. We build
// the key from EACH segment independently and only accept segments matching this strict
// allowlist — lowercase alphanumerics and interior hyphens, no dots or slashes. Because no
// segment can contain "." or "/", there is no path traversal ("..", encoded slashes) and
// no way to escape the ".pdf" suffix. We also bound depth so a request can't fan out keys.
const SEG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DEPTH = 8;

function keyFor(rawPath) {
  // Catch-all params come as an array (["wpblr","meetup"]); be defensive about strings too.
  const parts = Array.isArray(rawPath)
    ? rawPath
    : String(rawPath || "").split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_DEPTH) return null;
  const segs = parts.map((p) => String(p).toLowerCase());
  if (!segs.every((s) => SEG_RE.test(s))) return null;
  return segs.join("/") + ".pdf";
}

// Monthly updates only, so a short edge cache is plenty. ETag handles freshness:
// if the file is unchanged the browser/edge revalidates cheaply; when you upload a
// new deck the ETag changes and clients pull the new bytes automatically.
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=86400";

function notFound() {
  return new Response("Presentation not found. Upload a PDF to R2 named '<path>.pdf'.", {
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
  const { request, env, params, waitUntil } = context;

  if (!env.PDF_BUCKET) {
    return new Response("R2 binding 'PDF_BUCKET' is not configured.", { status: 500 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const objectKey = keyFor(params.path);
  if (!objectKey) return notFound(); // invalid/unsafe path -> treat as missing

  // Edge cache: a plain full GET is served straight from Cloudflare's cache, so a flood
  // of requests collapses to ~1 R2 read per cache TTL (see CACHE_CONTROL) — this shields
  // R2 ops and Function CPU from abuse/bursts. Range & conditional requests skip it.
  // The cache key is the request URL, so each deck caches independently.
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
  const head = await env.PDF_BUCKET.head(objectKey);
  if (!head) return notFound();

  const size = head.size;
  const etag = head.httpEtag; // already quoted
  const baseHeaders = {
    "content-type": "application/pdf",
    "accept-ranges": "bytes",
    "cache-control": CACHE_CONTROL,
    "x-content-type-options": "nosniff",
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
    const obj = await env.PDF_BUCKET.get(objectKey, {
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

  const obj = await env.PDF_BUCKET.get(objectKey);
  if (!obj) return notFound();
  const response = new Response(obj.body, {
    status: 200,
    headers: { ...baseHeaders, "content-length": String(size) },
  });
  // Populate the edge cache (TTL comes from Cache-Control) without delaying the response.
  if (cacheable) waitUntil(cache.put(request, response.clone()));
  return response;
}
