const loginPanel = document.querySelector("#login-panel");
const dashboard = document.querySelector("#dashboard");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const deviceList = document.querySelector("#device-list");
const pairingBox = document.querySelector("#pairing-box");
const mapPlaceholder = document.querySelector("#map-placeholder");
const locationDetails = document.querySelector("#location-details");

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Permintaan gagal.");
  return result;
}

function showDashboard() {
  loginPanel.classList.add("hidden");
  dashboard.classList.remove("hidden");
  refresh();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "";
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: new FormData(loginForm).get("password") }),
    });
    loginForm.reset();
    showDashboard();
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST", body: "{}" });
  dashboard.classList.add("hidden");
  loginPanel.classList.remove("hidden");
});

document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#password-message");
  message.textContent = "";
  try {
    await api("/api/admin/password", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    dashboard.classList.add("hidden");
    loginPanel.classList.remove("hidden");
    loginMessage.textContent = "Password berhasil diubah. Silakan masuk kembali.";
    event.currentTarget.reset();
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector("#pair-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const pairing = await api("/api/admin/pairing", { method: "POST", body: "{}" });
    document.querySelector("#pairing-code").textContent = pairing.code;
    pairingBox.classList.remove("hidden");
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
  }
});

function renderDevices(devices) {
  deviceList.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Belum ada perangkat terhubung.";
    deviceList.append(empty);
    return;
  }
  for (const device of devices) {
    const row = document.createElement("div");
    row.className = "device-row";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = device.name;
    const seen = document.createElement("small");
    seen.textContent = device.lastSeenAt
      ? `Terakhir aktif ${new Date(device.lastSeenAt).toLocaleString("id-ID")}`
      : "Belum mengirim lokasi";
    info.append(name, seen);
    const revoke = document.createElement("button");
    revoke.className = "revoke-button";
    revoke.type = "button";
    revoke.textContent = "Cabut";
    revoke.addEventListener("click", async () => {
      if (!window.confirm(`Cabut akses perangkat "${device.name}"?`)) return;
      try {
        await api(`/api/admin/devices/${encodeURIComponent(device.id)}/revoke`, { method: "POST", body: "{}" });
        await refresh();
      } catch (error) {
        window.alert(error.message);
      }
    });
    row.append(info, revoke);
    deviceList.append(row);
  }
}

function renderLocation(location) {
  if (!location) {
    mapPlaceholder.classList.remove("hidden");
    locationDetails.classList.add("hidden");
    document.querySelector("#location-device").textContent = "Belum ada lokasi";
    document.querySelector("#location-source").textContent = "MENUNGGU";
    return;
  }
  mapPlaceholder.classList.add("hidden");
  locationDetails.classList.remove("hidden");
  document.querySelector("#location-device").textContent = location.deviceName;
  const sourceLabels = { gps: "GPS", network: "JARINGAN", browser: "BROWSER" };
  document.querySelector("#location-source").textContent = sourceLabels[location.source] || "LOKASI";
  document.querySelector("#coordinates").textContent = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
  document.querySelector("#accuracy").textContent = `±${Math.round(location.accuracy)} m`;
  document.querySelector("#updated-at").textContent = new Date(location.updatedAt).toLocaleString("id-ID");
  document.querySelector("#map-link").href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(location.latitude)}&mlon=${encodeURIComponent(location.longitude)}#map=16/${encodeURIComponent(location.latitude)}/${encodeURIComponent(location.longitude)}`;
}

async function refresh() {
  try {
    const state = await api("/api/admin/state");
    renderDevices(state.devices);
    renderLocation(state.latestLocation);
  } catch (error) {
    if (error.message === "Admin login required") {
      dashboard.classList.add("hidden");
      loginPanel.classList.remove("hidden");
    } else {
      loginMessage.textContent = error.message;
    }
  }
}

api("/api/admin/state").then(showDashboard).catch(() => {});
window.setInterval(() => {
  if (!dashboard.classList.contains("hidden")) refresh();
}, 30_000);
