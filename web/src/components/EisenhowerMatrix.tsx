import { Link } from "react-router-dom";
import type { Todo } from "../api.ts";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-badge-active-bg text-badge-active-text",
  waiting: "bg-badge-waiting-bg text-badge-waiting-text",
  done: "bg-badge-done-bg text-badge-done-text",
  someday: "bg-badge-someday-bg text-badge-someday-text",
};

interface QuadrantProps {
  title: string;
  description: string;
  todos: Todo[];
  bgClass: string;
}

function Quadrant({ title, description, todos, bgClass }: QuadrantProps) {
  return (
    <div className={`rounded-xl p-4 ${bgClass} min-h-[180px]`}>
      <div className="mb-3">
        <h3 className="font-semibold text-sm text-text-primary">{title}</h3>
        <p className="text-[11px] text-text-muted">{description}</p>
      </div>
      {todos.length === 0 ? (
        <p className="text-xs text-text-muted italic">No items</p>
      ) : (
        <div className="flex flex-col gap-2">
          {todos.map((todo) => (
            <Link
              key={todo.id}
              to={`/todos/${todo.id}`}
              className="block p-2.5 bg-surface/80 rounded-lg hover:bg-surface transition-colors text-sm"
            >
              <div className="flex items-center gap-2">
                {todo.is_focus && <span className="text-pine-600 dark:text-pine-400 text-xs">★</span>}
                <span
                  className={`inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${
                    STATUS_COLORS[todo.status] ?? ""
                  }`}
                >
                  {todo.status}
                </span>
                <span className="text-text-primary font-medium truncate">{todo.title}</span>
              </div>
              {todo.next_step && (
                <p className="text-xs text-text-muted italic mt-1 truncate">{todo.next_step}</p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function EisenhowerMatrix({ todos }: { todos: Todo[] }) {
  const doFirst = todos.filter((t) => t.urgent && t.important && t.status !== "done");
  const schedule = todos.filter((t) => !t.urgent && t.important && t.status !== "done");
  const delegate = todos.filter((t) => t.urgent && !t.important && t.status !== "done");
  const someday = todos.filter((t) => !t.urgent && !t.important && t.status !== "done");

  return (
    <div className="grid grid-cols-2 gap-3">
      <Quadrant
        title="Do First"
        description="Urgent + Important"
        todos={doFirst}
        bgClass="bg-urgent-bg/50"
      />
      <Quadrant
        title="Schedule"
        description="Important, not urgent"
        todos={schedule}
        bgClass="bg-important-bg/50"
      />
      <Quadrant
        title="Delegate"
        description="Urgent, not important"
        todos={delegate}
        bgClass="bg-badge-waiting-bg/50"
      />
      <Quadrant
        title="Someday"
        description="Neither urgent nor important"
        todos={someday}
        bgClass="bg-badge-someday-bg/50"
      />
    </div>
  );
}
