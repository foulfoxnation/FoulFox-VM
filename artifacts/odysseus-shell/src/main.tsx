import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setBaseUrl } from "@workspace/api-client-react";

// When running inside Electron (production), the UI is loaded via file://
// and cannot use relative /api paths. Set the base URL to the loopback
// API server so all generated hooks resolve to the correct host.
if (window.location.protocol === "file:") {
  setBaseUrl("http://127.0.0.1:8080");
}

createRoot(document.getElementById("root")!).render(<App />);
