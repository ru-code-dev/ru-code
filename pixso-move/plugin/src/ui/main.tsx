import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { Toaster } from "./components/Toaster.tsx";
import "./index.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Toaster>
        <App />
      </Toaster>
    </StrictMode>,
  );
}
