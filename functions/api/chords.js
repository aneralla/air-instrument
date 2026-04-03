const SONGSTERR_API = 'https://www.songsterr.com/a/ra/songs/chords.json';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const songsterrId = url.searchParams.get('songsterrId');

  if (!songsterrId) {
    return Response.json({ error: 'Missing songsterrId' }, { status: 400 });
  }

  const kv = context.env.SONG_CACHE;
  const cacheKey = `chords:${songsterrId}`;

  // 1. Check KV cache (permanent — chord data never changes)
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, 'json');
      if (cached) {
        return Response.json(cached, {
          headers: { 'Cache-Control': 'public, max-age=86400', 'X-Cache': 'HIT' },
        });
      }
    } catch { /* KV miss or error — fall through */ }
  }

  // 2. Cache miss → fetch from Songsterr
  try {
    const res = await fetch(`${SONGSTERR_API}?id=${encodeURIComponent(songsterrId)}`);
    if (!res.ok) {
      return Response.json({ chords: [] }, { status: res.status });
    }

    const data = await res.json();

    // 3. Write to KV (no TTL — permanent)
    if (kv) {
      context.waitUntil(
        kv.put(cacheKey, JSON.stringify(data))
      );
    }

    return Response.json(data, {
      headers: { 'Cache-Control': 'public, max-age=86400', 'X-Cache': 'MISS' },
    });
  } catch {
    return Response.json({ chords: [] }, { status: 502 });
  }
}
