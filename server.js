const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const PUBLIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/admin", ["admin.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
]);

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

async function makePasswordRecord(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = await scrypt(password, salt, 64);
  return { salt, hash: hash.toString("hex") };
}

async function passwordMatches(password, record) {
  const candidate = await scrypt(password, record.salt, 64);
  const expected = Buffer.from(record.hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");
  const cookie = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function createAppServer(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, "data");
  const credentialsPath = path.join(dataDir, "admin.json");
  const statePath = path.join(dataDir, "state.json");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

  let credentials;
  try {
    credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    credentials = await makePasswordRecord(options.initialPassword || process.env.ADMIN_PASSWORD || "aan333");
    await fs.writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }

  let state = { devices: [], latestLocation: null };
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (!Array.isArray(state.devices)) throw new Error("Invalid device data in state file");
    if (state.latestLocation !== null && typeof state.latestLocation !== "object") {
      throw new Error("Invalid location data in state file");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const sessions = new Map();
  const loginAttempts = new Map();
  const pairingAttempts = new Map();
  let pairing = null;
  let writeQueue = Promise.resolve();

  async function persistState() {
    writeQueue = writeQueue.then(async () => {
      const temporaryPath = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, statePath);
    });
    return writeQueue;
  }

  function adminSession(req) {
    const token = getCookie(req, "sharelok_session");
    const expiresAt = sessions.get(token);
    if (!token || !expiresAt) return false;
    if (expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
  }

  function sessionCookie(req, value, maxAge) {
    const secure = req.socket.encrypted || process.env.TRUST_PROXY_TLS === "1" ? "; Secure" : "";
    return `sharelok_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && PUBLIC_FILES.has(pathname)) {
      const [filename, contentType] = PUBLIC_FILES.get(pathname);
      const contents = await fs.readFile(path.join(__dirname, "public", filename));
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(contents);
      return;
    }

    if (req.method === "POST" && !sameOrigin(req)) {
      sendJson(res, 403, { error: "Cross-origin request rejected" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/login") {
      const now = Date.now();
      const ip = req.socket.remoteAddress || "unknown";
      const recentAttempts = (loginAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60_000);
      if (recentAttempts.length >= 5) {
        sendJson(res, 429, { error: "Too many login attempts. Try again in one minute." });
        return;
      }
      recentAttempts.push(now);
      loginAttempts.set(ip, recentAttempts);
      const body = await readJson(req);
      const valid = typeof body.password === "string" && await passwordMatches(body.password, credentials);
      if (!valid) {
        sendJson(res, 401, { error: "Password is incorrect" });
        return;
      }
      const token = randomToken();
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, token, SESSION_TTL_MS / 1000) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/logout") {
      const token = getCookie(req, "sharelok_session");
      sessions.delete(token);
      sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
      return;
    }

    if (pathname.startsWith("/api/admin/")) {
      if (!adminSession(req)) {
        sendJson(res, 401, { error: "Admin login required" });
        return;
      }

      if (req.method === "GET" && pathname === "/api/admin/state") {
        sendJson(res, 200, {
          devices: state.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt })),
          latestLocation: state.latestLocation,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/admin/password") {
        const body = await readJson(req);
        if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" ||
            body.newPassword.length < 12 || body.newPassword.length > 1024) {
          sendJson(res, 400, { error: "Enter the current password and a new password of at least 12 characters" });
          return;
        }
        if (!await passwordMatches(body.currentPassword, credentials)) {
          sendJson(res, 401, { error: "Current password is incorrect" });
          return;
        }
        const nextCredentials = await makePasswordRecord(body.newPassword);
        const temporaryPath = `${credentialsPath}.${process.pid}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(nextCredentials, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporaryPath, credentialsPath);
        credentials = nextCredentials;
        sessions.clear();
        sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/admin/pairing") {
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        pairing = { code, expiresAt: Date.now() + PAIRING_TTL_MS };
        sendJson(res, 200, { code, expiresAt: new Date(pairing.expiresAt).toISOString() });
        return;
      }

      const revokeMatch = pathname.match(/^\/api\/admin\/devices\/([a-f0-9-]+)\/revoke$/);
      if (req.method === "POST" && revokeMatch) {
        const device = state.devices.find((item) => item.id === revokeMatch[1]);
        if (!device) {
          sendJson(res, 404, { error: "Device not found" });
          return;
        }
        state.devices = state.devices.filter((item) => item.id !== device.id);
        if (state.latestLocation?.deviceId === device.id) state.latestLocation = null;
        await persistState();
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (req.method === "POST" && pathname === "/api/device/register") {
      const now = Date.now();
      const ip = req.socket.remoteAddress || "unknown";
      const attempts = (pairingAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 60_000);
      if (attempts.length >= 5) {
        sendJson(res, 429, { error: "Too many pairing attempts. Try again in one minute." });
        return;
      }
      attempts.push(now);
      pairingAttempts.set(ip, attempts);
      const body = await readJson(req);
      if (!pairing || pairing.expiresAt <= Date.now() || body.code !== pairing.code) {
        sendJson(res, 403, { error: "Pairing code is invalid or expired" });
        return;
      }
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 60) {
        sendJson(res, 400, { error: "Device name must be 1 to 60 characters" });
        return;
      }
      const token = randomToken();
      const device = {
        id: crypto.randomUUID(),
        name: body.name.trim(),
        tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
      };
      state.devices.push(device);
      pairing = null;
      await persistState();
      sendJson(res, 201, { token, deviceId: device.id });
      return;
    }

    if (req.method === "POST" && pathname === "/api/device/location") {
      const authorization = req.headers.authorization || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const device = state.devices.find((item) => {
        const expected = Buffer.from(item.tokenHash, "hex");
        const actual = Buffer.from(tokenHash, "hex");
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
      });
      if (!device) {
        sendJson(res, 401, { error: "Valid device token required" });
        return;
      }
      const body = await readJson(req);
      const validCoordinates =
        typeof body.latitude === "number" && Number.isFinite(body.latitude) && body.latitude >= -90 && body.latitude <= 90 &&
        typeof body.longitude === "number" && Number.isFinite(body.longitude) && body.longitude >= -180 && body.longitude <= 180;
      if (!validCoordinates || typeof body.accuracy !== "number" || !Number.isFinite(body.accuracy) || body.accuracy < 0 ||
          !["gps", "network", "browser"].includes(body.source)) {
        sendJson(res, 400, { error: "Location must include valid coordinates, accuracy, and source (gps, network, or browser)" });
        return;
      }
      const now = new Date().toISOString();
      device.lastSeenAt = now;
      state.latestLocation = {
        deviceId: device.id,
        deviceName: device.name,
        latitude: body.latitude,
        longitude: body.longitude,
        accuracy: body.accuracy,
        source: body.source,
        updatedAt: now,
      };
      await persistState();
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  const server = http.createServer((req, res) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    handle(req, res).catch((error) => {
      console.error("Request failed:", error);
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Internal server error" });
      else res.destroy(error);
    });
  });

  return server;
}

if (require.main === module) {
  createAppServer().then((server) => {
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || "127.0.0.1";
    server.listen(port, host, () => {
      console.log(`Sharelok listening at http://${host}:${port}`);
      console.log("For browser geolocation or remote access, deploy behind HTTPS.");
    });
  }).catch((error) => {
    console.error("Could not start Sharelok:", error);
    process.exitCode = 1;
  });
}

module.exports = { createAppServer };
