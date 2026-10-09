import { basename, resolve } from "node:path";
import { readBoardSources } from "./board-reader.mjs";
import { buildBoardModel } from "./board-model.mjs";
import { renderBoardHtml, renderBoardText, renderTaskText, renderBoardStatus } from "./board-render.mjs";

const fold = value => String(value).normalize("NFC").toLowerCase();
export function boardView({ sources, scope = "all", project = null, taskId = null, format = "chat", now = new Date().toISOString() }) {
  if (!["chat", "task", "status", "html"].includes(format)) throw new TypeError("unknown board format");
  if (taskId !== null && !/^T[1-9]\d*$/.test(taskId)) throw new TypeError("task id must be T followed by a positive number");
  const snapshots = readBoardSources(sources, { now: Date.parse(now) });
  const projects = snapshots.flatMap(source => source.projects);
  let selected = projects;
  if (scope !== "all") {
    if (scope === "this") {
      if (!project) throw new RangeError("this board needs the current project");
      selected = projects.filter(book => book.checkout && resolve(book.checkout) === resolve(project));
      if (!selected.length) selected = projects.filter(book => fold(book.name.replace(/-[0-9a-f]{6}$/, "")) === fold(basename(project)));
    } else selected = projects.filter(book => [book.key, book.name, book.name.replace(/-[0-9a-f]{6}$/, ""), ...(book.checkout ? [basename(book.checkout)] : [])].some(name => fold(name) === fold(scope)));
    if (!selected.length || scope !== "this" && selected.length !== 1) throw new RangeError(selected.length ? `The project is ambiguous. Choose: ${selected.map(book => book.key).join(", ")}` : "No recorded project matches this board scope.");
  }
  const keys = new Set(selected.map(book => book.key));
  const model = buildBoardModel(snapshots.map(source => ({ ...source, projects: source.projects.filter(book => keys.has(book.key)) })), { now });
  if (taskId) {
    const tasks = model.tasks.filter(task => task.id === taskId);
    if (tasks.length !== 1) {
      if (tasks.length) throw new RangeError(`The task is ambiguous. Choose its project: ${tasks.map(task => task.project).join(", ")}`);
      const nearby = [...new Set(model.tasks.map(task => task.id))].sort((a,b) => Math.abs(Number(a.slice(1)) - Number(taskId.slice(1))) - Math.abs(Number(b.slice(1)) - Number(taskId.slice(1)))).slice(0, 3);
      throw new RangeError(`Unknown task ${taskId}. Nearest recorded ids: ${nearby.join(", ") || "none"}. No task was opened.`);
    }
    return format === "html" ? renderBoardHtml(model, { taskKey: tasks[0].key }) : renderTaskText(tasks[0]);
  }
  if (format === "task") throw new TypeError("task view needs a task id");
  return format === "html" ? renderBoardHtml(model) : format === "status" ? renderBoardStatus(model) : renderBoardText(model);
}
