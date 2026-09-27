const WebSocket = require("ws");
const crypto = require("crypto");
const { fetchVersionForRoom } = require("./utils/version");

const LOWER_ALPHA = "abcdefghijklmnopqrstuvwxyz";

const DEFAULTS = {
  host: "magicgarden.gg",
  gameName: "Quinoa",
  // A complete desktop Chrome UA, consistent with `platform="desktop"`.
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
};

const GAME_SCOPE = ["Room", DEFAULTS.gameName];

// Sent the moment the socket opens. The server waits for it to admit the
// connection and closes the socket (4410 AdmissionTimedOut) without it.
const SOCKET_OPENED = { type: "SocketOpened" };

// Same 5s budget the game client gives a QuinoaCommand before giving up.
const COMMAND_TIMEOUT_MS = 5000;

// The first command of a session is `Welcome.executedCommandSequence + 1`.
const FIRST_COMMAND_SEQUENCE = 1;

// The server sends a text "ping" every ~4s; the game client reconnects once it
// has heard none for 10s, checking every second.
const HEARTBEAT_TIMEOUT_MS = 10000;
const HEARTBEAT_CHECK_MS = 1000;

// The game client gives up on a socket that has not been welcomed in 30s.
const HANDSHAKE_TIMEOUT_MS = 30000;

// WebSocket close codes, as the game client names them (bundle 1284).
const CLOSE_CODES = {
  ReconnectInitiated: 4100,
  PlayerLeftVoluntarily: 4200,
  UserSessionSuperseded: 4250,
  ConnectionSuperseded: 4300,
  ServerDisposed: 4310,
  RoomTransitioning: 4320,
  HeartbeatExpired: 4400,
  AdmissionTimedOut: 4410,
  ConnectionAttemptObsolete: 4420,
  PlayerKicked: 4500,
  VersionMismatch: 4700,
  VersionExpired: 4710,
  UserDataSchemaAhead: 4720,
  UnreadableUserData: 4721,
  AuthenticationFailure: 4800,
  UnexpectedHandshakeError: 4801,
  UserNotFound: 4810,
  AuthenticatingExternalAccountRemoved: 4830,
  SessionExpired: 4840,
  Banned: 4900,
};

// Codes after which the game client never reconnects on its own.
const PERMANENT_CLOSE_CODES = new Set([
  4300, 4250, 4500, 4700, 4710, 4720, 4721, 4800, 4801, 4810, 4830, 4840, 4900,
]);

// Another tab/device took over the session. The game client stops and offers
// to reclaim; an AFK client reclaims on its own after `supersededMs`.
const SUPERSEDED_CODES = new Set([CLOSE_CODES.UserSessionSuperseded, CLOSE_CODES.ConnectionSuperseded]);

// The room moved to another build: the game client reloads the page. We
// re-fetch the version (done before every reconnect) and connect again.
const VERSION_CODES = new Set([CLOSE_CODES.VersionMismatch, CLOSE_CODES.VersionExpired]);

// The game client tolerates this many handshake errors (4801) within a minute.
const HANDSHAKE_ERROR_MAX = 3;
const HANDSHAKE_ERROR_WINDOW_MS = 60000;

// Messages the game client drops rather than queues while disconnected: they
// are stale by the time the socket comes back.
const NOISY_MESSAGES = [
  ["Room", "MarkChatRead"],
  ["Room", "ChatTyping"],
  ["Quinoa", "PlayerPosition"],
  ["Quinoa", "HarvestCrop"],
  ["Quinoa", "PurchaseShopItem"],
  ["Quinoa", "Ping"],
  ["Quinoa", "SetSelectedItem"],
  ["Quinoa", "PickupObject"],
  ["Quinoa", "DropObject"],
];

const RETRY = {
  minDelayMs: 1500,
  jitterMs: 1000,
  // Retries with no delay while a first connection has never been welcomed.
  initialFastMax: 5,
};

const DEFAULT_RECONNECT_DELAYS = {
  supersededMs: 30000,
  otherMs: 1500,
  maxDelayMs: 60000,
};

// Player fields that only carry a value once the server accepted our mc_jwt
// cookie; a guest gets none of them. `databaseUserId` was renamed to
// `discordUserId`, either is accepted.
const AUTH_IDENTITY_KEYS = ["discordUserId", "databaseUserId"];

function generateRoomId() {
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes)
    .map((b) => LOWER_ALPHA[b % LOWER_ALPHA.length])
    .join("");
}

function isNoisy(message) {
  const scope = message.scopePath?.[message.scopePath.length - 1];
  const type = message.type === "QuinoaCommand" ? message.command?.type : message.type;
  return NOISY_MESSAGES.some(([s, t]) => s === scope && t === type);
}

// The server now only sends RoomFrame (patches under `state.patches`, plus
// `events`); the game client no longer knows PartialState. Normalize a frame
// that carries patches into the PartialState shape the rest of this client
// consumes. A frame without `state` (only `executedCommandSequence`) is passed
// through as a RoomFrame.
function normalizePartialState(msg) {
  if (!msg || msg.type !== "RoomFrame") return msg;
  const patches = msg.state?.patches;
  if (!patches) return msg;
  const { type, state, ...rest } = msg;
  return { ...rest, type: "PartialState", patches };
}

function normalizeCookie(cookie) {
  const trimmed = (cookie || "").trim();
  if (!trimmed) return "";
  return trimmed.includes("mc_jwt") ? trimmed : `mc_jwt=${trimmed}`;
}

/**
 * Query values are JSON-encoded (quotes included), exactly like the web client.
 * No `playerId` (the server assigns it and reports it as `selfPlayerId` in
 * Welcome) and no `source`, which the web client doesn't send.
 *
 * @param {{ documentId: string, connectionAttempt: number,
 *   navigationType?: "navigate" | "reload", reclaimSupersededSession: boolean }} client
 */
function buildUrl(host, version, room, client) {
  const base = `wss://${host}/version/${version}/api/rooms/${room}/connect`;
  const params = new URLSearchParams([
    ["surface", '"web"'],
    ["platform", '"desktop"'],
    ["version", `"${version}"`],
    ["capabilities", '"fbo_mipmap_unsupported"'],
    ["locale", '"en"'],
  ]);
  // Booleans and numbers go raw, strings are quoted.
  if (client.reclaimSupersededSession) params.append("reclaimSupersededSession", "true");
  params.append("clientDocumentId", `"${client.documentId}"`);
  params.append("clientConnectionAttempt", String(client.connectionAttempt));
  // The page's navigation type, which a reconnect doesn't change.
  params.append("clientNavigationType", `"${client.navigationType || "navigate"}"`);
  params.append("clientVisibilityState", '"visible"');
  return `${base}?${params}`;
}

class Connection {
  /**
   * @param {object} opts
   * @param {boolean} [opts.reconnect=true] - reconnect automatically after an
   *   unexpected close (never after disconnect(), an auth failure, or a close
   *   code the game treats as final: kicked, banned, session expired, ...)
   * @param {boolean} [opts.reclaimSuperseded=true] - when another tab/device
   *   takes the session over (4250/4300), take it back after `supersededMs`.
   *   This kicks that other session out in turn.
   * @param {Partial<typeof DEFAULT_RECONNECT_DELAYS>} [opts.reconnectDelays]
   * @param {() => Promise<string>} [opts.versionFetcher] - re-run before every
   *   reconnect, so a game update during a retry loop is picked up. Defaults to
   *   the room's own version.
   */
  constructor({
    cookie, room, version, host, userAgent, commandTimeoutMs,
    reconnect = true, reclaimSuperseded = true, reconnectDelays, versionFetcher,
    // Guest accounts (device-account / provider "localstorage") have no
    // discordUserId/databaseUserId on their player - opt in to accept them.
    allowGuest = false,
  } = {}) {
    this.cookie = normalizeCookie(cookie);
    this.room = (room || "").trim() || generateRoomId();
    this.version = (version || "").trim();
    this.allowGuest = allowGuest;
    this.host = host || DEFAULTS.host;
    this.userAgent = userAgent || DEFAULTS.userAgent;
    this.commandTimeoutMs = commandTimeoutMs || COMMAND_TIMEOUT_MS;
    this.reconnect = reconnect;
    this.reclaimSuperseded = reclaimSuperseded;
    this.reconnectDelays = { ...DEFAULT_RECONNECT_DELAYS, ...reconnectDelays };
    this.versionFetcher = versionFetcher || (() => fetchVersionForRoom(this.room, this.host));

    // Assigned by the server, known once Welcome arrives (`selfPlayerId`).
    this.playerId = null;

    this.ws = null;
    this.onMessage = null; // callback(parsed) - set from main.js
    // callback(status, info) - "connecting" | "connected" | "reconnecting" | "disconnected" | "error"
    this.onStatus = null;

    // Client context sent in the connect URL: the document id stays stable
    // across auto-retries while connectionAttempt counts up.
    this.documentId = crypto.randomUUID();
    this.connectionAttempt = 1;
    this.lastCloseCode = null;

    this.welcomed = false;
    this.hasEverWelcomed = false;
    this.manualClose = false;
    this.retryCount = 0;
    this.retryTimer = null;
    this.initialFastRetry = false;
    this.handshakeErrors = 0;
    this.lastHandshakeErrorAt = 0;

    this.heartbeatTimer = null;
    this.handshakeTimer = null;
    this.lastServerPingAt = 0;

    // Flat messages sent before Welcome, flushed after it (see sendMessage).
    this.pendingMessages = [];

    this._resetCommandSession();
  }

  connect({ isRetry = false } = {}) {
    if (!this.cookie || !this.version) {
      throw new Error("Missing cookie or version");
    }

    this._closeSocket(CLOSE_CODES.ReconnectInitiated, "reconnect initiated", { keepQueued: true });
    this._cancelRetry();

    if (!isRetry) {
      this.retryCount = 0;
      this.handshakeErrors = 0;
      this.initialFastRetry = !this.hasEverWelcomed;
      this.documentId = crypto.randomUUID();
    }
    // retryCount was already incremented by _scheduleReconnect, so the first
    // retry is attempt 2 - same numbering as the web client.
    this.connectionAttempt = isRetry ? this.retryCount + 1 : 1;
    this.manualClose = false;
    this.welcomed = false;
    this.playerId = null;

    const url = buildUrl(this.host, this.version, this.room, {
      documentId: this.documentId,
      connectionAttempt: this.connectionAttempt,
      reclaimSupersededSession: SUPERSEDED_CODES.has(this.lastCloseCode),
    });

    this._emitStatus("connecting", { attempt: this.connectionAttempt });

    const ws = new WebSocket(url, {
      headers: {
        "User-Agent": this.userAgent,
        Cookie: this.cookie,
        Origin: `https://${this.host}`,
      },
    });
    this.ws = ws;

    ws.on("open", () => this._onOpen());
    ws.on("message", (data) => this._onRawMessage(data));
    ws.on("close", (code, reason) => this._onClose(code, reason.toString()));
    ws.on("error", (err) => this._onError(err));

    this._startHandshakeTimeout();
    return url;
  }

  disconnect() {
    this.manualClose = true;
    this._cancelRetry();
    this.retryCount = 0;
    this.pendingMessages = [];
    this._closeSocket(CLOSE_CODES.PlayerLeftVoluntarily, "player left voluntarily");
    this._emitStatus("disconnected", { code: CLOSE_CODES.PlayerLeftVoluntarily, manual: true });
  }

  /** Write to the socket as-is, if it is open. */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
    }
  }

  /** Whether the server has admitted this socket (Welcome received). */
  isConnected() {
    return this.welcomed && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a flat `{ scopePath, type, ... }` message the way the game client
   * does: right away once welcomed, otherwise queued until the next Welcome -
   * except "noisy" messages (positions, chat-read marks, ...), which would be
   * stale by then and are dropped.
   */
  sendMessage(message) {
    if (this.isConnected()) this.send(message);
    else if (!isNoisy(message)) this.pendingMessages.push(message);
  }

  // --- Quinoa command envelope ---

  /**
   * Send a gameplay command inside the QuinoaCommand envelope:
   *   { scopePath, type: "QuinoaCommand", requestId, commandSequence, command }
   *
   * Commands are only valid once the server has sent Welcome (that message
   * carries the sequence number to resume from), so anything sent earlier is
   * queued and flushed on Welcome.
   *
   * @param {{type: string}} command
   * @returns {Promise<object|null>} the QuinoaCommandResult
   *   (`{ ok, code?, commandType, payload?, itemGains? }`), or null on timeout
   *   / disconnect. Never rejects, so callers may ignore the promise.
   * @param {{ timeoutMs?: number }} [options] - result wait, defaults to commandTimeoutMs`n   */
  sendQuinoaCommand(command, { timeoutMs } = {}) {
    if (!this.commandSessionReady) {
      return new Promise((resolve) => {
        this.pendingCommands.push({ command, timeoutMs, resolve });
      });
    }
    return this._dispatchQuinoaCommand(command, timeoutMs);
  }

  /** Sequence number the next command will carry (nth command since Welcome). */
  nextCommandSequence() {
    return this.commandSequence;
  }

  // --- Internal ---

  _emitStatus(status, info = {}) {
    if (this.onStatus) this.onStatus(status, info);
  }

  /**
   * @param {boolean} [keepQueued] - keep commands that were never sent, so they
   *   go out after the next Welcome (a connect or a reconnect) instead of being
   *   dropped
   */
  _closeSocket(code, reason, { keepQueued = false } = {}) {
    this._stopTimers();
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (ws) {
      ws.removeAllListeners();
      // Closing a socket that is still connecting emits "error"; swallow it.
      ws.on("error", () => {});
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    }
    this._resetCommandSession({ keepQueued });
  }

  _resetCommandSession({ keepQueued = false } = {}) {
    // Nothing in flight can still be answered: settle waiters instead of
    // leaving their promises hanging.
    for (const { resolve, timeoutId } of this.pendingResults?.values() || []) {
      clearTimeout(timeoutId);
      resolve(null);
    }
    if (!keepQueued) {
      for (const { resolve } of this.pendingCommands || []) resolve(null);
      this.pendingCommands = []; // sent before Welcome, flushed after
    }

    this.commandSessionReady = false;
    this.commandSequence = FIRST_COMMAND_SEQUENCE;
    this.executedCommandSequence = 0;
    this.pendingResults = new Map(); // requestId -> { resolve, timeoutId }
  }

  _dispatchQuinoaCommand(command, timeoutMs = this.commandTimeoutMs) {
    const requestId = crypto.randomUUID();
    const commandSequence = this.commandSequence;
    this.commandSequence += 1;

    this.send({
      scopePath: GAME_SCOPE,
      type: "QuinoaCommand",
      requestId,
      commandSequence,
      command,
    });

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingResults.delete(requestId);
        resolve(null);
      }, timeoutMs);
      timeoutId.unref?.(); // a pending result shouldn't keep the process alive
      this.pendingResults.set(requestId, { resolve, timeoutId });
    });
  }

  _onCommandSessionReady(welcome) {
    // Resume where the server left off; absent field means a fresh session.
    this.executedCommandSequence = welcome.executedCommandSequence || 0;
    this.commandSequence = this.executedCommandSequence + 1;
    this.commandSessionReady = true;

    const queued = this.pendingCommands;
    this.pendingCommands = [];
    for (const { command, timeoutMs, resolve } of queued) {
      this._dispatchQuinoaCommand(command, timeoutMs).then(resolve);
    }
  }

  _onCommandResult(msg) {
    const pending = this.pendingResults.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.pendingResults.delete(msg.requestId);
    pending.resolve(msg);
  }

  /**
   * Announce the socket, then say nothing more until the server's Welcome:
   * game messages sent before it go into a socket that is not admitted yet.
   */
  _onOpen() {
    this.send(SOCKET_OPENED);
  }

  /** The game messages that may only go out once the server admitted the socket. */
  _sendPostWelcomeHandshake() {
    this.send({ scopePath: ["Room"], type: "VoteForGame", gameName: DEFAULTS.gameName });
    this.send({ scopePath: ["Room"], type: "SetSelectedGame", gameName: DEFAULTS.gameName });
  }

  /** @returns {boolean} false when the Welcome was rejected (auth failure). */
  _handleWelcome(msg) {
    // The server assigns our player id and tells us which one it is; without
    // it nothing in `players` / `userSlots` can be matched to us.
    if (msg.selfPlayerId) this.playerId = msg.selfPlayerId;

    const players = msg.fullState?.data?.players || [];
    const me = players.find((p) => p && p.id === this.playerId);
    if (
      me &&
      !this.allowGuest &&
      !AUTH_IDENTITY_KEYS.some((key) => me[key] != null)
    ) {
      this._failAuth("Invalid mc_jwt cookie.");
      return false;
    }

    const firstWelcome = !this.welcomed;
    if (firstWelcome) {
      this.welcomed = true;
      this._clearHandshakeTimeout();
      this._startHeartbeat();
      // Handshake before anything queued: the game must be selected first.
      this._sendPostWelcomeHandshake();
    }
    this._onCommandSessionReady(msg);
    for (const message of this.pendingMessages.splice(0)) this.sendMessage(message);

    if (firstWelcome) {
      const wasRetry = this.retryCount > 0;
      this.retryCount = 0;
      this.lastCloseCode = null;
      this.hasEverWelcomed = true;
      this.initialFastRetry = false;
      this._cancelRetry();
      this._emitStatus("connected", { room: this.room, playerId: this.playerId, reconnected: wasRetry });
    }
    return true;
  }

  _failAuth(message) {
    this.manualClose = true;
    this._cancelRetry();
    this.retryCount = 0;
    this.initialFastRetry = false;
    this.pendingMessages = [];
    this._closeSocket(CLOSE_CODES.PlayerLeftVoluntarily, "auth failed");
    this._emitStatus("error", { message, code: CLOSE_CODES.AuthenticationFailure });
  }

  _onRawMessage(data) {
    const raw = data.toString();

    // Respond to server pings; they are also the heartbeat.
    if (raw === "ping" || raw === '"ping"') {
      this.lastServerPingAt = Date.now();
      this.send("pong");
      return;
    }

    // Ignore pong
    if (raw === "pong" || raw === '"pong"') return;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (parsed.type === "Welcome") {
      if (!this._handleWelcome(parsed)) return;
    } else if (parsed.type === "RoomFrame") {
      this.executedCommandSequence = Math.max(
        this.executedCommandSequence,
        parsed.executedCommandSequence || 0
      );
    } else if (parsed.type === "QuinoaCommandResult") {
      this._onCommandResult(parsed);
    }

    if (this.onMessage) {
      this.onMessage(normalizePartialState(parsed));
    }
  }

  _onClose(code, reason) {
    this.lastCloseCode = code;
    this._stopTimers();
    this.ws?.removeAllListeners();
    this.ws = null;
    this.welcomed = false;
    this._resetCommandSession({ keepQueued: true });
    this._emitStatus("disconnected", { code, reason });

    // Queued commands wait for the reconnect; with none coming, settle them.
    const reconnecting = !this.manualClose && this.reconnect && this._scheduleReconnect(code);
    if (!reconnecting) {
      this._resetCommandSession();
      this.pendingMessages = [];
    }
  }

  // A failed socket is always followed by "close" (code 1006), which handles
  // the reconnect.
  _onError() {}

  // --- Timers ---

  _startHeartbeat() {
    this._stopHeartbeat();
    this.lastServerPingAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && Date.now() - this.lastServerPingAt > HEARTBEAT_TIMEOUT_MS) {
        this.ws.terminate(); // emits close 1006 -> reconnect
      }
    }, HEARTBEAT_CHECK_MS);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _startHandshakeTimeout() {
    this._clearHandshakeTimeout();
    this.handshakeTimer = setTimeout(() => {
      if (this.ws && !this.welcomed) this.ws.terminate(); // close 1006 -> reconnect
    }, HANDSHAKE_TIMEOUT_MS);
  }

  _clearHandshakeTimeout() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  _stopTimers() {
    this._stopHeartbeat();
    this._clearHandshakeTimeout();
  }

  // --- Reconnection ---

  /** Whether a close with `code` should be followed by a reconnect. */
  _shouldReconnect(code) {
    if (code === CLOSE_CODES.UnexpectedHandshakeError) {
      const now = Date.now();
      if (now - this.lastHandshakeErrorAt > HANDSHAKE_ERROR_WINDOW_MS) this.handshakeErrors = 0;
      this.lastHandshakeErrorAt = now;
      this.handshakeErrors += 1;
      return this.handshakeErrors <= HANDSHAKE_ERROR_MAX;
    }
    if (SUPERSEDED_CODES.has(code)) return this.reclaimSuperseded;
    if (VERSION_CODES.has(code)) return true;
    return !PERMANENT_CLOSE_CODES.has(code);
  }

  _reconnectDelay(code) {
    const { supersededMs, otherMs, maxDelayMs } = this.reconnectDelays;
    const configured = Math.max(0, SUPERSEDED_CODES.has(code) ? supersededMs : otherMs);
    const base = Math.max(configured, RETRY.minDelayMs);
    const max = Math.max(maxDelayMs, RETRY.minDelayMs);
    const backoff = Math.min(base * 2 ** Math.max(0, this.retryCount - 1), max);
    return backoff + Math.floor(Math.random() * RETRY.jitterMs);
  }

  _scheduleReconnect(code) {
    if (!this._shouldReconnect(code)) {
      this._emitStatus("error", { message: "Closed for good by the server", code });
      return false;
    }
    const isInitial = this.initialFastRetry && !this.hasEverWelcomed;
    if (isInitial && this.retryCount >= RETRY.initialFastMax) {
      this._emitStatus("error", { message: "Retries exhausted", code });
      return false;
    }

    this.retryCount += 1;
    const delayMs = isInitial ? 0 : this._reconnectDelay(code);
    this._emitStatus("reconnecting", { attempt: this.retryCount, delayMs, code });

    this._cancelRetry();
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      await this._refreshVersion();
      if (this.manualClose) return;
      try {
        this.connect({ isRetry: true });
      } catch (err) {
        this._emitStatus("error", { message: err.message });
        this._resetCommandSession();
      }
    }, delayMs);
    return true;
  }

  /** Skip the current retry delay (e.g. when the network comes back). */
  retryNow() {
    if (!this.retryTimer) return;
    this._cancelRetry();
    this._refreshVersion().then(() => {
      if (!this.manualClose) this.connect({ isRetry: true });
    });
  }

  // Better a stale version than no retry at all, so failures keep the old one.
  async _refreshVersion() {
    try {
      const fetched = ((await this.versionFetcher()) || "").trim();
      if (fetched) this.version = fetched;
    } catch {}
  }

  _cancelRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

module.exports = {
  Connection,
  DEFAULTS,
  GAME_SCOPE,
  COMMAND_TIMEOUT_MS,
  CLOSE_CODES,
  PERMANENT_CLOSE_CODES,
  SUPERSEDED_CODES,
  buildUrl,
  normalizePartialState,
};
