const SONGSTERR_API = 'https://www.songsterr.com/a/ra/songs/chords.json';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const songsterrId = url.searchParams.get('songsterrId');

  if (!songsterrId) {
    return Response.json({ error: 'Missing songsterrId' }, { status: 400 });
  }

  try {
    const res = await fetch(`${SONGSTERR_API}?id=${encodeURIComponent(songsterrId)}`);
    if (!res.ok) {
      return Response.json({ chords: [] }, { status: res.status });
    }

    const data = await res.json();
    return Response.json(data, {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    return Response.json({ chords: [] }, { status: 502 });
  }
}
