import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.tsx";
import { QuickSwitcher } from "./components/QuickSwitcher.tsx";
import { ArtifactList } from "./pages/ArtifactList.tsx";
import { ArtifactCreate } from "./pages/ArtifactCreate.tsx";
import { ArtifactEdit } from "./pages/ArtifactEdit.tsx";
import { TodoList } from "./pages/TodoList.tsx";
import { TodoCreate } from "./pages/TodoCreate.tsx";
import { TodoEdit } from "./pages/TodoEdit.tsx";
import { Weight } from "./pages/Weight.tsx";
import { DbObservability } from "./pages/DbObservability.tsx";
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
          <Route path="/todos" element={<TodoList />} />
          <Route path="/todos/new" element={<TodoCreate />} />
          <Route path="/todos/:id" element={<TodoEdit />} />
          <Route path="/:id" element={<ArtifactEdit />} />
        </Routes>
      </AuthGate>
    </BrowserRouter>
  </StrictMode>
);
