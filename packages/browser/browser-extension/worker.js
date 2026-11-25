import { profile, extensionVersion, assetRevision } from "./profile.js";
import { createBrowserRouter } from "./router.js";
import { createExtensionConnection } from "./connection.js";
import { createVisualController } from "./visual.js";

let connection;
const visual = createVisualController(chrome, {
  emit: (event) => connection?.publish(event),
  persist: (markers) =>
    chrome.storage.session.set({ nexumVisualMarkers: markers }),
});
const router = createBrowserRouter(chrome, {
  visual,
  emit: (event) => connection?.publish(event),
  persistOwned: (records) =>
    chrome.storage.session.set({ nexumOwnedControls: records }),
});
connection = createExtensionConnection({
  chrome,
  router,
  profile,
  extensionVersion,
  assetRevision,
});
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: "https://nexum.y2l.top/" });
});

void connection.start().catch(() => {});
