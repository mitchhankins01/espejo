import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ArtifactList } from "./pages/ArtifactList.tsx";
import { ArtifactCreate } from "./pages/ArtifactCreate.tsx";
import { ArtifactEdit } from "./pages/ArtifactEdit.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ArtifactList />} />
        <Route path="/new" element={<ArtifactCreate />} />
        <Route path="/:id" element={<ArtifactEdit />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
