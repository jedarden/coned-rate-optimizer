/* Agentation visual-feedback toolbar (conedrat-341ced52).
   Dynamically imported from index.html only when ?feedback=1 is set — the
   React + agentation payload never loads for normal visitors, so their page
   makes exactly the same requests as before it existed (the site's
   no-upload promise stays intact). Agentation itself makes no network
   calls: it renders a local toolbar and copies structured feedback
   markdown to the clipboard. Versions are pinned so the toolbar mounts the
   same way every time; imports are full URLs, so no import map is needed.
   The React host uses the workspace-canonical `agentation-root` id so the
   mount check (tools/verify-agentation-mount.js) has a stable marker;
   the toolbar UI itself portals to body and renders in a shadow root. */

const [{ default: React }, { createRoot }, { Agentation }] = await Promise.all([
  import("https://esm.sh/react@18.3.1"),
  import("https://esm.sh/react-dom@18.3.1/client"),
  import("https://esm.sh/agentation@3.1.2?deps=react@18.3.1,react-dom@18.3.1&bundle"),
]);

let host = document.getElementById("agentation-root");
if (!host) {
  host = document.createElement("div");
  host.id = "agentation-root";
  document.body.appendChild(host);
}

createRoot(host).render(React.createElement(Agentation));

console.info("[feedback] Agentation enabled (?feedback=1). Click any element to annotate.");
