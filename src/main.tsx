import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { UiDock } from "./components/UiDock";
import "./styles.css";
import "./stemEditor.css";
import "./resample.css";
import "./split.css";
import "./chopsticks.css";
import "./chopsticks-copy.css";
import "./chopsticks-tools.css";
import "./chopsticks-sampler.css";
import "./chopsticks-qa.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <UiDock />
  </React.StrictMode>
);
