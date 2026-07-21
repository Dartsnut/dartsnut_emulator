import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeAnalytics, installAnalyticsClickTracking } from "./analytics";
import "./themes.css";
import "./tailwind.css";
import "./styles.css";

void initializeAnalytics();
installAnalyticsClickTracking();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
