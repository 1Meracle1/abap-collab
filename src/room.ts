const ROOM_PATTERN = /^[a-z0-9-]{8,64}$/;

export function roomIdFromPath(pathname: string): string | undefined {
  const match = /^\/room\/([^/]+)\/?$/.exec(pathname);
  if (match === null || !ROOM_PATTERN.test(match[1])) {
    return undefined;
  }
  return match[1];
}

export function createRoomId(randomUUID: () => string = () => crypto.randomUUID()): string {
  return randomUUID().replaceAll("-", "").slice(0, 12).toLowerCase();
}

export function ensureRoomUrl(location: Location, history: History): string {
  const existingRoomId = roomIdFromPath(location.pathname);
  if (existingRoomId !== undefined) {
    return existingRoomId;
  }

  const roomId = createRoomId();
  history.replaceState(null, "", `/room/${roomId}${location.search}${location.hash}`);
  return roomId;
}
