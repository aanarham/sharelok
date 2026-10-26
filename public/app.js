const form = document.querySelector("#sharing-form");
const nameInput = document.querySelector("#device-name");
const codeInput = document.querySelector("#pairing-code-input");
const consentInput = document.querySelector("#location-consent");
const startButton = document.querySelector("#start-sharing");
const stopButton = document.querySelector("#stop-sharing");
const message = document.querySelector("#sharing-message");
const status = document.querySelector("#tracking-status");
const deviceLabel = document.querySelector("#sharing-device");
const STORAGE_KEY = "sharelok_browser_device";
const UPDATE_INTERVAL_MS = 30_000;

let trackingId = null;
let latestPosition = null;
let updateTimer = null;
let sending = false;
let uploadController = null;
let lastSentAt = 0;

function savedDevice() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Permintaan gagal.");
  return result;
}

function showTracking(active, name = "") {
  startButton.classList.toggle("hidden", active);
  stopButton.classList.toggle("hidden", !active);
  nameInput.disabled = active;
  codeInput.disabled = active;
  consentInput.disabled = active;
  status.textContent = active ? "Menunggu izin/lokasi" : "Belum aktif";
  deviceLabel.textContent = active ? name : "Lokasi tetap privat";
}

async function sendLatestPosition() {
  if (!latestPosition || sending || Date.now() - lastSentAt < UPDATE_INTERVAL_MS) return;
  const device = savedDevice();
  if (!device?.token) {
    stopSharing();
    setMessage("Sesi perangkat tidak ditemukan. Minta kode pairing baru dari admin.", true);
    return;
  }
  sending = true;
  lastSentAt = Date.now();
  uploadController = new AbortController();
  const controller = uploadController;
  const position = latestPosition;
  try {
    await api("/api/device/location", {
      method: "POST",
      headers: { Authorization: `Bearer ${device.token}` },
      signal: controller.signal,
      body: JSON.stringify({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        source: "browser",
      }),
    });
    setMessage(`Lokasi terkirim · akurasi sekitar ±${Math.round(position.coords.accuracy)} m.`);
  } catch (error) {
    if (error.name !== "AbortError") setMessage(error.message, true);
    if (error.message === "Valid device token required") {
      stopSharing();
      localStorage.removeItem(STORAGE_KEY);
      codeInput.required = true;
    }
  } finally {
    sending = false;
    if (uploadController === controller) uploadController = null;
  }
}

function onPosition(position) {
  latestPosition = position;
  status.textContent = "Berbagi aktif";
  sendLatestPosition();
}

function onLocationError(error) {
  const messages = {
    1: "Izin lokasi ditolak. Ubah izin situs di pengaturan browser jika ingin berbagi.",
    2: "Lokasi belum tersedia. Periksa layanan lokasi perangkat dan coba lagi.",
    3: "Permintaan lokasi terlalu lama. Pastikan layanan lokasi aktif lalu coba lagi.",
  };
  latestPosition = null;
  if (error.code === 1) stopSharing();
  else status.textContent = "Lokasi belum tersedia";
  setMessage(messages[error.code] || "Lokasi tidak dapat diakses.", true);
}

function stopSharing() {
  if (trackingId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(trackingId);
  }
  trackingId = null;
  latestPosition = null;
  sending = false;
  uploadController?.abort();
  uploadController = null;
  window.clearInterval(updateTimer);
  updateTimer = null;
  showTracking(false);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("");
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    setMessage("Berbagi lokasi memerlukan HTTPS. Buka situs melalui koneksi aman.", true);
    return;
  }
  if (!navigator.geolocation) {
    setMessage("Browser ini tidak mendukung geolocation.", true);
    return;
  }
  if (!consentInput.checked) {
    setMessage("Setujui pembagian lokasi sebelum melanjutkan.", true);
    return;
  }

  startButton.disabled = true;
  try {
    let device = savedDevice();
    if (!device?.token) {
      const name = nameInput.value.trim();
      const code = codeInput.value.trim();
      if (!name || !/^\d{6}$/.test(code)) throw new Error("Masukkan nama perangkat dan kode pairing 6 digit.");
      device = await api("/api/device/register", {
        method: "POST",
        body: JSON.stringify({ name, code }),
      });
      device.name = name;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
      codeInput.value = "";
    }
    nameInput.value = device.name;
    trackingId = navigator.geolocation.watchPosition(onPosition, onLocationError, {
      enableHighAccuracy: true,
      maximumAge: 10_000,
      timeout: 20_000,
    });
    updateTimer = window.setInterval(sendLatestPosition, UPDATE_INTERVAL_MS);
    showTracking(true, device.name);
    setMessage("Meminta lokasi dari browser… Biarkan halaman ini terbuka selama berbagi.");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    startButton.disabled = false;
  }
});

stopButton.addEventListener("click", () => {
  stopSharing();
  setMessage("Berbagi lokasi dihentikan. Admin tidak akan menerima pembaruan baru.");
});

window.addEventListener("pagehide", () => {
  if (trackingId !== null) navigator.geolocation.clearWatch(trackingId);
  window.clearInterval(updateTimer);
  uploadController?.abort();
});

const existingDevice = savedDevice();
if (existingDevice?.name && existingDevice?.token) {
  nameInput.value = existingDevice.name;
  codeInput.required = false;
  codeInput.placeholder = "Perangkat sudah dipasangkan";
}
