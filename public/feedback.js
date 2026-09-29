/* Agentation visual-feedback toolbar (conedrat-341ced52).
   Dynamically imported from index.html only when ?feedback=1 is set — the
   React + agentation payload never loads for normal visitors, so their page
   makes exactly the same requests as before it existed (the site's
   no-upload promise stays intact). Agentation itself makes no network
   calls: it renders a local toolbar and copies structured feedback
   markdown to the clipboard. Versions are pinned in index.html's import map
   so the toolbar mounts the same way every time.
   The React host uses the workspace-canonical `agentation-root` id so the
   mount check (tools/verify-agentation-mount.js) has a stable marker;
   the toolbar UI itself portals to body and renders in a shadow root. */

import React from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";

let host = document.getElementById("agentation-root");
if (!host) {
  host = document.createElement("div");
  host.id = "agentation-root";
  document.body.appendChild(host);
}

createRoot(host).render(React.createElement(Agentation));

console.info("[feedback] Agentation enabled (?feedback=1). Click any element to annotate.");
