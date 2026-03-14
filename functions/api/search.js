const SONGSTERR_API = 'https://www.songsterr.com/a/ra/songs.json';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams.get('q');

  if (!q || q.trim().length < 2) {
    return Response.json({ songs: [] });
  }

  try {
    const res = await fetch(`${SONGSTERR_API}?pattern=${encodeURIComponent(q)}`);
    if (!res.ok) return Response.json({ songs: [] });

    const data = await res.json();
    const songs = data.slice(0, 15).map((s) => ({
      id: `songsterr-${s.id}`,
      title: s.title,
      artist: s.artist.name,
      bpm: 120,
      songsterrId: s.id,
      progression: [],
    }));

    return Response.json({ songs }, {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    return Response.json({ songs: [] }, { status: 502 });
  }
}
