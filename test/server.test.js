const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createAppServer } = require("../server");

let server;
let baseUrl;
let dataDir;
let adminCookie;

async function post(route, body, headers = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sharelok-test-"));
  server = await createAppServer({ dataDir, initialPassword: "aan333" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("admin login, pairing, location privacy, and device revocation work end to end", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/admin/state`);
  assert.equal(unauthenticated.status, 401);

  const credentials = JSON.parse(await fs.readFile(path.join(dataDir, "admin.json"), "utf8"));
  assert.equal(JSON.stringify(credentials).includes("aan333"), false);

  const login = await post("/api/admin/login", { password: "aan333" });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get("set-cookie").split(";")[0];

  const pairingResponse = await post("/api/admin/pairing", {}, { Cookie: adminCookie });
  assert.equal(pairingResponse.status, 200);
  const { code } = await pairingResponse.json();
  assert.match(code, /^\d{6}$/);

  const registration = await post("/api/device/register", { code, name: "Browser test" });
  assert.equal(registration.status, 201);
  const { token, deviceId } = await registration.json();

  const location = await post("/api/device/location", {
    latitude: -6.2,
    longitude: 106.8,
    accuracy: 25,
    source: "browser",
  }, { Authorization: `Bearer ${token}` });
  assert.equal(location.status, 200);

  const adminState = await fetch(`${baseUrl}/api/admin/state`, { headers: { Cookie: adminCookie } });
  assert.equal(adminState.status, 200);
  const state = await adminState.json();
  assert.equal(state.latestLocation.latitude, -6.2);
  assert.equal(state.devices[0].name, "Browser test");
  assert.equal(Object.hasOwn(state.devices[0], "token"), false);

  const revoke = await post(`/api/admin/devices/${deviceId}/revoke`, {}, { Cookie: adminCookie });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/admin/state`, { headers: { Cookie: adminCookie } })).status, 200);
  const revokedState = await (await fetch(`${baseUrl}/api/admin/state`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(revokedState.latestLocation, null);
  const rejectedLocation = await post("/api/device/location", {
    latitude: -6.2, longitude: 106.8, accuracy: 25, source: "browser",
  }, { Authorization: `Bearer ${token}` });
  assert.equal(rejectedLocation.status, 401);
});

test("pairing codes expire after one use and invalid coordinates are rejected", async () => {
  const pairingResponse = await post("/api/admin/pairing", {}, { Cookie: adminCookie });
  const { code } = await pairingResponse.json();
  const first = await post("/api/device/register", { code, name: "One use" });
  assert.equal(first.status, 201);
  const second = await post("/api/device/register", { code, name: "Replay" });
  assert.equal(second.status, 403);

  const { token } = await first.json();
  const invalid = await post("/api/device/location", {
    latitude: 91, longitude: 0, accuracy: -1, source: "gps",
  }, { Authorization: `Bearer ${token}` });
  assert.equal(invalid.status, 400);
});

test("admin can rotate the password and old sessions are invalidated", async () => {
  const changed = await post("/api/admin/password", {
    currentPassword: "aan333",
    newPassword: "sharelok-passphrase-2026",
  }, { Cookie: adminCookie });
  assert.equal(changed.status, 200);
  const oldSession = await fetch(`${baseUrl}/api/admin/state`, { headers: { Cookie: adminCookie } });
  assert.equal(oldSession.status, 401);

  const oldLogin = await post("/api/admin/login", { password: "aan333" });
  assert.equal(oldLogin.status, 401);
  const newLogin = await post("/api/admin/login", { password: "sharelok-passphrase-2026" });
  assert.equal(newLogin.status, 200);
  adminCookie = newLogin.headers.get("set-cookie").split(";")[0];
});
