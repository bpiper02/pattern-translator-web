import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { StemEditor } from "./components/StemEditor";
import "./styles.css";
import "./stemEditor.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <>
      <App />
      <main className="machineShell stemEditorShell">
        <StemEditor />
      </main>
    </>
  </React.StrictMode>
);
