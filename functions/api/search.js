const SONGSTERR_API = 'https://www.songsterr.com/api/songs';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams.get('q')?.trim().toLowerCase();

  if (!q || q.length < 2) {
    return Response.json({ songs: [] });
  }

  const kv = context.env.SONG_CACHE;
  const cacheKey = `search:${q}`;

  // 1. Check KV cache
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, 'json');
      if (cached) {
        return Response.json({ songs: cached }, {
          headers: { 'Cache-Control': 'public, max-age=3600', 'X-Cache': 'HIT' },
        });
      }
    } catch { /* KV miss or error — fall through to API */ }
  }

  // 2. Cache miss → fetch from Songsterr
  try {
    const res = await fetch(`${SONGSTERR_API}?pattern=${encodeURIComponent(q)}`);
    if (!res.ok) return Response.json({ songs: [] });

    const data = await res.json();
    const songs = data.slice(0, 15).map((s) => ({
      id: `songsterr-${s.songId}`,
      title: s.title,
      artist: s.artist,
      bpm: 120,
      songsterrId: s.songId,
      progression: [],
    }));

    // 3. Write to KV (7-day TTL)
    if (kv && songs.length > 0) {
      context.waitUntil(
        kv.put(cacheKey, JSON.stringify(songs), { expirationTtl: 604800 })
      );
    }

    return Response.json({ songs }, {
      headers: { 'Cache-Control': 'public, max-age=3600', 'X-Cache': 'MISS' },
    });
  } catch {
    return Response.json({ songs: [] }, { status: 502 });
  }
}
