import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.tsx";
import { QuickSwitcher } from "./components/QuickSwitcher.tsx";
import { ArtifactList } from "./pages/ArtifactList.tsx";
import { ArtifactCreate } from "./pages/ArtifactCreate.tsx";
import { ArtifactEdit } from "./pages/ArtifactEdit.tsx";
import { Weight } from "./pages/Weight.tsx";
import { DbObservability } from "./pages/DbObservability.tsx";
import { EntryList } from "./pages/EntryList.tsx";
import { EntryCreate } from "./pages/EntryCreate.tsx";
import { EntryEdit } from "./pages/EntryEdit.tsx";
import { TemplateList } from "./pages/TemplateList.tsx";
import { TemplateCreate } from "./pages/TemplateCreate.tsx";
import { TemplateEdit } from "./pages/TemplateEdit.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate>
        <QuickSwitcher />
        <Routes>
          <Route path="/" element={<ArtifactList />} />
          <Route path="/new" element={<ArtifactCreate />} />
          <Route path="/weight" element={<Weight />} />
          <Route path="/db" element={<DbObservability />} />
          <Route path="/journal" element={<EntryList />} />
          <Route path="/journal/new" element={<EntryCreate />} />
          <Route path="/journal/:uuid" element={<EntryEdit />} />
          <Route path="/templates" element={<TemplateList />} />
          <Route path="/templates/new" element={<TemplateCreate />} />
          <Route path="/templates/:id" element={<TemplateEdit />} />
          <Route path="/:id" element={<ArtifactEdit />} />
        </Routes>
      </AuthGate>
    </BrowserRouter>
  </StrictMode>
);
