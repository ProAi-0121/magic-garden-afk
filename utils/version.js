const DEFAULT_HOST = "magicgarden.gg";

// A room page references `/version/<v>/` from a dozen places (icons, manifest,
// thumbnails); the `/assets/` bundle is the one the room actually runs.
const ROOM_VERSION_REGEX = /\/version\/([^/"]+)\/assets\//;

async function fetchVersion(host = DEFAULT_HOST) {
  const res = await fetch(`https://${host}/platform/v1/version`);
  if (!res.ok) throw new Error(`Version fetch failed: ${res.status}`);
  const data = await res.json();
  if (!data.version) throw new Error("No version field in response");
  return data.version;
}

function parseRoomVersion(html) {
  return ROOM_VERSION_REGEX.exec(html)?.[1] || null;
}

/**
 * The version a given room runs on, or null when the page can't be read.
 * Rooms are not migrated in lockstep with the platform, so connecting with the
 * latest global version is rejected ("version expired") on a room still
 * running an older build.
 */
async function fetchRoomVersion(room, host = DEFAULT_HOST) {
  const trimmed = (room || "").trim();
  if (!trimmed) return null;
  try {
    const res = await fetch(`https://${host}/r/${trimmed}`);
    if (!res.ok) return null;
    return parseRoomVersion(await res.text());
  } catch {
    return null;
  }
}

/** The room's own version, falling back to the latest platform version. */
async function fetchVersionForRoom(room, host = DEFAULT_HOST) {
  return (await fetchRoomVersion(room, host)) || fetchVersion(host);
}

module.exports = { fetchVersion, fetchRoomVersion, fetchVersionForRoom, parseRoomVersion };
