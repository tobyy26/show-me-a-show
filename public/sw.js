// Minimal service worker — required by browsers for "Add to Home Screen"
// eligibility. Not doing offline caching here since results are always
// meant to be fresh/live.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", () => {
  // Pass-through, no caching — this app is meant to always hit the network.
});
