// POST /api/lookup
// Body: { lat, lng, radiusMiles, artists: string[] }
// Env vars needed (set as Pages secrets): TICKETMASTER_KEY, BANDSINTOWN_APP_ID

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normKey(artist, dateStr, venue) {
  const clean = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${clean(artist)}|${(dateStr || "").slice(0, 10)}|${clean(venue)}`;
}

async function fetchTicketmaster(env, lat, lng, radiusMiles, artist) {
  if (!env.TICKETMASTER_KEY) return [];
  const url = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
  url.searchParams.set("apikey", env.TICKETMASTER_KEY);
  url.searchParams.set("latlong", `${lat},${lng}`);
  url.searchParams.set("radius", String(radiusMiles));
  url.searchParams.set("unit", "miles");
  url.searchParams.set("classificationName", "music");
  url.searchParams.set("keyword", artist);
  url.searchParams.set("sort", "date,asc");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = await res.json();
    const events = data?._embedded?.events || [];
    return events.map((e) => {
      const venue = e._embedded?.venues?.[0];
      return {
        source: "ticketmaster",
        artist,
        title: e.name,
        date: e.dates?.start?.dateTime || e.dates?.start?.localDate,
        venue: venue?.name || "",
        city: venue?.city?.name || "",
        url: e.url,
      };
    });
  } catch {
    return [];
  }
}

async function fetchBandsintown(env, lat, lng, radiusMiles, artist) {
  if (!env.BANDSINTOWN_APP_ID) return [];
  const url = `https://rest.bandsintown.com/artists/${encodeURIComponent(
    artist
  )}/events?app_id=${encodeURIComponent(env.BANDSINTOWN_APP_ID)}&date=upcoming`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const events = await res.json();
    if (!Array.isArray(events)) return [];
    return events
      .filter((e) => {
        const evLat = parseFloat(e.venue?.latitude);
        const evLng = parseFloat(e.venue?.longitude);
        if (Number.isNaN(evLat) || Number.isNaN(evLng)) return true; // keep if no coords, filter later by city if needed
        return haversineMiles(lat, lng, evLat, evLng) <= radiusMiles;
      })
      .map((e) => ({
        source: "bandsintown",
        artist,
        title: `${artist} at ${e.venue?.name || "venue TBA"}`,
        date: e.datetime,
        venue: e.venue?.name || "",
        city: e.venue?.city || "",
        url: e.url,
      }));
  } catch {
    return [];
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { lat, lng, radiusMiles = 30, artists = [] } = body;

  if (typeof lat !== "number" || typeof lng !== "number") {
    return Response.json({ error: "lat and lng (numbers) are required" }, { status: 400 });
  }
  if (!Array.isArray(artists) || artists.length === 0) {
    return Response.json({ error: "artists must be a non-empty array" }, { status: 400 });
  }

  // Fire all artist x source lookups in parallel
  const calls = artists.flatMap((artist) => [
    fetchTicketmaster(env, lat, lng, radiusMiles, artist),
    fetchBandsintown(env, lat, lng, radiusMiles, artist),
  ]);

  const results = (await Promise.all(calls)).flat();

  // Dedupe: same artist + date + venue seen from multiple sources
  const seen = new Map();
  for (const ev of results) {
    if (!ev.date) continue;
    const key = normKey(ev.artist, ev.date, ev.venue);
    if (!seen.has(key)) {
      seen.set(key, ev);
    } else {
      // prefer the entry that has a ticket url if the existing one doesn't
      const existing = seen.get(key);
      if (!existing.url && ev.url) seen.set(key, ev);
    }
  }

  const events = [...seen.values()].sort((a, b) => new Date(a.date) - new Date(b.date));

  return Response.json({ count: events.length, events });
}
