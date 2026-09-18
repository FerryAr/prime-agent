// Prime Agent web — minimal service worker: notifications with system sound.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		(async () => {
			const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const client = list[0];
			if (client) return client.focus();
			return self.clients.openWindow("/");
		})(),
	);
});
