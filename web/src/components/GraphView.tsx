import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { getArtifactGraph, type GraphData } from "../api.ts";

interface GraphViewProps {
  onNavigate: (id: string) => void;
}

interface ThemeColors {
  nodeStroke: string;
  text: string;
  semantic: string;
  explicit: string;
  muted: string;
}

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  return {
    nodeStroke: style.getPropertyValue("--color-border").trim() || "#d1dbd3",
    text: style.getPropertyValue("--color-text-primary").trim() || "#1a2b1e",
    semantic: style.getPropertyValue("--color-pine-500").trim() || "#3d9a5e",
    explicit: style.getPropertyValue("--color-pine-600").trim() || "#2e7d50",
    muted: style.getPropertyValue("--color-text-muted").trim() || "#536b57",
  };
}

function kindColor(kind: string): string {
  switch (kind) {
    case "insight":
      return "#4f8fb8";
    case "theory":
      return "#8a62bd";
    case "model":
      return "#4f9d67";
    case "reference":
      return "#b98a56";
    case "note":
      return "#9f8b6e";
    default:
      return "#888888";
  }
}

export function GraphView({ onNavigate }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [data, setData] = useState<GraphData>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<ThemeColors>(() => readThemeColors());

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    getArtifactGraph()
      .then((graph) => {
        if (!active) return;
        setData(graph);
      })
      .catch((err) => {
        if (!active) return;
        setError(String(err));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({
        width: Math.max(320, Math.floor(width)),
        height: Math.max(320, Math.floor(height)),
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateTheme = () => setTheme(readThemeColors());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    updateTheme();
    media.addEventListener("change", updateTheme);
    return () => media.removeEventListener("change", updateTheme);
  }, []);

  const graph = useMemo(
    () => ({
      nodes: data.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        kind: node.kind,
      })),
      links: data.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        weight: edge.weight,
      })),
    }),
    [data]
  );

  if (loading) {
    return (
      <div
        ref={containerRef}
        className="w-full h-full flex items-center justify-center text-text-muted"
      >
        Loading graph...
      </div>
    );
  }

  if (error) {
    return (
      <div
        ref={containerRef}
        className="w-full h-full flex items-center justify-center text-red-600 dark:text-red-400"
      >
        {error}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full">
      <ForceGraph2D
        width={size.width}
        height={size.height}
        graphData={graph}
        nodeLabel={(node) => String((node as { title: string }).title)}
        onNodeClick={(node) => onNavigate(String((node as { id: string }).id))}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const artifactNode = node as {
            id: string;
            title: string;
            kind: string;
            x: number;
            y: number;
          };
          const radius = 7;
          const fontSize = 12 / globalScale;
          ctx.beginPath();
          ctx.arc(artifactNode.x, artifactNode.y, radius, 0, 2 * Math.PI, false);
          ctx.fillStyle = kindColor(artifactNode.kind);
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = theme.nodeStroke;
          ctx.stroke();
          ctx.font = `${fontSize}px sans-serif`;
          ctx.fillStyle = theme.text;
          ctx.fillText(
            artifactNode.title,
            artifactNode.x + radius + 2,
            artifactNode.y + radius + 2
          );
        }}
        linkColor={(link) => {
          const typed = link as { type: string };
          if (typed.type === "explicit") return theme.explicit;
          if (typed.type === "semantic") return theme.semantic;
          return theme.muted;
        }}
        linkWidth={(link) => {
          const typed = link as { type: string; weight?: number };
          if (typed.type === "explicit") return 2.8;
          if (typed.type === "semantic") {
            const weight = typed.weight ?? 0.3;
            return Math.max(1, weight * 4);
          }
          return 1.2;
        }}
        linkLineDash={(link) => {
          const typed = link as { type: string };
          if (typed.type === "source") return [2, 4];
          return [];
        }}
      />
    </div>
  );
}
