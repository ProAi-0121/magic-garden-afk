require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const util = require("util");

const {
    Connection
} = require("./connection");

const {
    fetchVersionForRoom
} = require("./utils/version");

const AFK_ROOM = process.env.AFK_ROOM || "AZZABR";

const AFK_ACCOUNT_COUNT = Math.max(1, Number(process.env.AFK_COUNT || 5));

const HOST = "magicgarden.gg";

const RESPAWN_DELAY_MS = 5000;

const FATAL_CLOSE_CODES = new Set([
    4250, 4300, 4500, 4800, 4801, 4810, 4830, 4840, 4900,
]);

const CLOSE_CODE_NAMES = {
    4250: "UserSessionSuperseded",
    4300: "ConnectionSuperseded",
    4400: "HeartbeatExpired",
    4500: "PlayerKicked",
    4700: "VersionMismatch",
    4800: "AuthenticationFailure",
    4810: "UserNotFound",
    4900: "Banned",
};

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";


const isTTY = process.stdout.isTTY === true;

const status = {
    sessionStart: Date.now(),
    totalReconnects: 0,
    totalRespawns: 0,
};

const accounts = [];

const logLines = [];
let frameLines = 0;

const origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

console.log = (...a) => botLog(...a);
console.warn = (...a) => botLog("⚠", ...a);
console.error = (...a) => botLog("✖", ...a);

function botLog(...parts) {
    const msg = parts
        .map((p) => (typeof p === "string" ? p : util.inspect(p, { depth: 3 })))
        .join(" ");
    const stamp = new Date().toLocaleTimeString("en-GB");
    logLines.push(`${stamp} ${msg}`);
    while (logLines.length > 12) logLines.shift();
    if (!isTTY) origConsole.log(...parts);
    else renderFrame();
}

function fmtElapsed(from) {
    const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0
        ? `${h}h ${pad(m)}m ${pad(sec)}s`
        : `${m}m ${pad(sec)}s`;
}

function accountGlyph(acc) {
    switch (acc.state) {
        case "connected": return "\x1b[32m✓\x1b[0m";
        case "connecting":
        case "reconnecting": return "\x1b[33m~\x1b[0m";
        case "provisioning": return "\x1b[36m*\x1b[0m";
        default: return "\x1b[31m✗\x1b[0m";
    }
}

function renderFrame() {
    if (!isTTY) return;

    const connected = accounts.filter((a) => a.state === "connected").length;
    const lines = [];
    lines.push(
        `╔══ AFK SQUAD ── room ${AFK_ROOM} ── ` +
        `${new Date().toLocaleTimeString("en-GB")} ${"═".repeat(14)}`
    );
    lines.push(
        `║ Connected  ${connected}/${accounts.length}  |  ` +
        `session ${fmtElapsed(status.sessionStart)}  |  ` +
        `reconnects ${status.totalReconnects}  |  ` +
        `respawns ${status.totalRespawns}`
    );
    lines.push(`╠══ ACCOUNTS ${"─".repeat(50)}`);
    for (const acc of accounts) {
        const since = acc.connectedAt || acc.stateSince || status.sessionStart;
        lines.push(
            `║ ${String(acc.index).padStart(2)} ${accountGlyph(acc)} ` +
            `${acc.state.padEnd(13)} ${String(acc.userId || "-").padEnd(24)} ` +
            `${acc.state === "connected" ? `up ${fmtElapsed(since)}` : ""}`
        );
    }
    lines.push(`╠══ LOG ${"─".repeat(54)}`);
    for (const l of logLines) lines.push(`  ${l.slice(0, 100)}`);
    lines.push(`╠══ KEYS ${"─".repeat(52)}`);
    lines.push("  [q] quit  [g] save account cookies to dumps/afk_accounts.json");
    lines.push(`╚${"═".repeat(62)}`);

    let out = "\x1b[?25l";
    if (frameLines > 0) out += `\x1b[${frameLines}A\r`;
    for (const line of lines) out += `\x1b[2K${line}\n`;
    process.stdout.write(out);
    frameLines = lines.length;
}

const dashboardTimer = setInterval(renderFrame, 500);
dashboardTimer.unref?.();


function newDeviceToken() {
    return crypto.randomBytes(32)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

async function provisionGuest() {
    const res = await fetch(
        `https://${HOST}/api/rooms/${AFK_ROOM}/user/device-account`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "Origin": `https://${HOST}`,
                "Referer": `https://${HOST}/r/${AFK_ROOM}`,
            },
            body: JSON.stringify({
                token: newDeviceToken(),
                locale: "en-US",
                accountCreationContext: { surface: "web" },
            }),
        }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.isAuthenticated) {
        throw new Error(
            `device-account failed: HTTP ${res.status} ` +
            `${JSON.stringify(data).slice(0, 200)}`
        );
    }

    const cookies = res.headers.getSetCookie
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    const jwt = cookies
        .map((c) => /mc_jwt=([^;]+)/.exec(c)?.[1])
        .find(Boolean);
    if (!jwt) throw new Error("device-account returned no mc_jwt cookie");

    return {
        userId: data.databaseUser?.id || "unknown",
        cookie: `mc_jwt=${jwt}`,
    };
}

let version = "";

async function startAccount(acc) {
    acc.state = "provisioning";
    acc.stateSince = Date.now();
    acc.connectedAt = null;
    acc.userId = null;

    try {
        const guest = await provisionGuest();
        acc.userId = guest.userId;
        acc.cookie = guest.cookie;

        const conn = new Connection({
            cookie: acc.cookie,
            room: AFK_ROOM,
            version,
            reclaimSuperseded: true,
            allowGuest: true,
        });
        acc.conn = conn;

        conn.onStatus = (connStatus, info) => {
            const code = info?.code;
            const name = code
                ? ` (${CLOSE_CODE_NAMES[code] || code})`
                : "";

            if (connStatus === "connected") {
                if (acc.hasWelcomed) {
                    status.totalReconnects += 1;
                    acc.reconnects = (acc.reconnects || 0) + 1;
                    console.log(
                        `[RECONNECT] #${acc.index} ${acc.userId} back in room`
                    );
                }
                acc.hasWelcomed = true;
                acc.state = "connected";
                acc.connectedAt = Date.now();
                acc.stateSince = acc.connectedAt;
                console.log(
                    `[JOINED] #${acc.index} ${acc.userId} connected to ${AFK_ROOM}`
                );
            } else {
                acc.state = connStatus;
                acc.stateSince = Date.now();
                if (connStatus !== "connecting") {
                    console.log(`[WS] #${acc.index} ${connStatus}${name}`);
                }
            }
            renderFrame();
        };

        conn.onMessage = () => {};

        acc.fatalWatcher = setInterval(() => {
            if (conn.lastCloseCode && FATAL_CLOSE_CODES.has(conn.lastCloseCode)) {
                respawnAccount(
                    acc,
                    `close ${conn.lastCloseCode} ` +
                    `${CLOSE_CODE_NAMES[conn.lastCloseCode] || ""}`
                );
            }
        }, 2000);
        acc.fatalWatcher.unref?.();

        conn.connect();
    } catch (err) {
        console.error(
            `[PROVISION FAILED] #${acc.index}: ` +
            (err && err.message ? err.message : err)
        );
        acc.state = "error";
        acc.stateSince = Date.now();
        setTimeout(() => startAccount(acc), RESPAWN_DELAY_MS).unref?.();
    }
}

function respawnAccount(acc, reason) {
    if (acc.respawnQueued) return;
    acc.respawnQueued = true;
    status.totalRespawns += 1;
    console.log(`[RESPAWN] #${acc.index} (${reason}) - new guest incoming`);
    try {
        if (acc.fatalWatcher) clearInterval(acc.fatalWatcher);
        acc.conn?.disconnect();
    } catch {  }
    acc.hasWelcomed = false;
    setTimeout(() => {
        acc.respawnQueued = false;
        startAccount(acc);
    }, RESPAWN_DELAY_MS).unref?.();
}


function saveAccountFile() {
    const outDir = path.join(__dirname, "dumps");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    const file = path.join(outDir, "afk_accounts.json");
    fs.writeFileSync(
        file,
        JSON.stringify(
            accounts.map((a) => ({
                index: a.index,
                userId: a.userId,
                cookie: a.cookie,
                state: a.state,
            })),
            null,
            2
        )
    );
    console.log(`[DUMP] account cookies saved to ${file}`);
}

function setupKeyboard() {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
        console.log("[KEYS] stdin is not a TTY - keyboard controls disabled");
        return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
        if (key === "\u0003") return quit();
        if (key.toLowerCase() === "q") return quit();
        if (key.toLowerCase() === "g") return saveAccountFile();
    });
    console.log("[KEYS] [q] quit | [g] save account cookies");
}

function quit() {
    console.log("[QUIT] disconnecting all accounts…");
    for (const acc of accounts) {
        try { acc.fatalWatcher && clearInterval(acc.fatalWatcher); } catch {}
        try { acc.conn?.disconnect(); } catch {}
    }
    if (isTTY) process.stdout.write("\x1b[?25h\n");
    process.exit(0);
}

process.on("SIGINT", quit);

async function main() {
    version = await fetchVersionForRoom(AFK_ROOM);
    console.log(
        `[AFK] joining room ${AFK_ROOM} with ${AFK_ACCOUNT_COUNT} ` +
        `guest accounts (version ${version})`
    );

    for (let i = 0; i < AFK_ACCOUNT_COUNT; i++) {
        const acc = { index: i + 1, state: "idle", stateSince: Date.now() };
        accounts.push(acc);
        setTimeout(() => startAccount(acc), i * 1500).unref?.();
    }

    setupKeyboard();
}

main().catch((err) => {
    if (isTTY) process.stdout.write("\x1b[?25h\n");
    origConsole.error(err);
    process.exit(1);
});
