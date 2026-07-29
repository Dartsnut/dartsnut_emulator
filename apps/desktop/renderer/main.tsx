import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeAnalytics, installAnalyticsClickTracking } from "./analytics";
import "./themes.css";
import "./tailwind.css";
import "./styles.css";

const WEB_FONTS_STYLESHEET =
  "https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@500;600;700;800&display=swap";

// Remote fonts are visual enhancement only. Loading them after the initial document load
// prevents an unreachable font host from keeping Electron's first window blank.
window.addEventListener("load", () => {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = WEB_FONTS_STYLESHEET;
  document.head.appendChild(stylesheet);
}, { once: true });

void initializeAnalytics();
installAnalyticsClickTracking();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
