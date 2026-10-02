export async function registerWorker(
  onWaiting: (worker: ServiceWorker) => void,
) {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.register("/sw.js", {
    updateViaCache: "none",
  });
  if (registration.waiting) onWaiting(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (installing)
      installing.addEventListener("statechange", () => {
        if (
          installing.state === "installed" &&
          navigator.serviceWorker.controller &&
          registration.waiting
        )
          onWaiting(registration.waiting);
      });
  });
  window.addEventListener("focus", () => {
    void registration.update().catch(() => {
      // The installed shell remains usable when an update check is offline.
    });
  });
  return registration;
}
export function activateWorker(worker: ServiceWorker) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      reject(new Error("Update timed out; pending data is preserved."));
    }, 15000);
    function changed() {
      clearTimeout(timer);
      resolve();
    }
    navigator.serviceWorker.addEventListener("controllerchange", changed, {
      once: true,
    });
    try {
      worker.postMessage({ type: "ACTIVATE" });
    } catch {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      reject(
        new Error(
          "The waiting update is unavailable; saved data is preserved.",
        ),
      );
    }
  });
}
