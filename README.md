# Sharelok

Sharelok is a consent-based location-sharing web app with a Node.js server, a public sharing page, and an admin dashboard. A user starts sharing explicitly in the browser; only the latest location is retained.

## Run the website and API

Requirements: Node.js 20 or later.

```sh
npm start
```

Open `http://127.0.0.1:3000` for the public page or `/admin` for the admin dashboard. The first run creates `data/admin.json`, which contains a salted scrypt password hash, not the password itself. The initial password is `aan333`. Change it in the admin dashboard (new passwords must be at least 12 characters) before making the service available to anyone else.

Set `PORT` and `HOST` to configure the listener. The default listener is loopback-only. For another device to access the site, deploy it behind HTTPS; browser geolocation is restricted to secure contexts (except localhost). If TLS terminates at a trusted reverse proxy, set `TRUST_PROXY_TLS=1` so admin cookies receive the `Secure` attribute. Do not expose the server over plain HTTP on a public or untrusted network. The location API retains only the latest point and device access tokens as hashes; it does not store a location history.

## Pair and share a browser's location

1. Sign in at `/admin` and create a pairing code.
2. On the device that will share its location, open the public page, enter a device name and pairing code, then explicitly consent and start sharing.
3. Approve the browser's location permission prompt. Keep the page open while sharing; use **Hentikan berbagi** to stop sending updates. Closing or reloading the page stops active tracking.
4. The browser sends the latest available position every 30 seconds while the page is active. The dashboard also refreshes every 30 seconds. Admins can revoke a paired device, which also clears its latest location.

The browser's Geolocation API provides coordinates and an accuracy estimate, but does not identify whether the location came from GPS, cellular, Wi-Fi, or another source. A website cannot read raw cell tower identifiers or directly request a BTS lookup. Background execution and update timing are controlled by the browser and operating system; suspended tabs may not send on schedule.

## Tests

```sh
npm test
```
