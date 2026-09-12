export const CODE_COLUMNS = [
  { key: "code", label: "Code", get: (c) => c.code },
  { key: "assessment", label: "Assessment", get: (c) => c.assessment_title || "" },
  { key: "link", label: "Candidate link", get: (c) => c.code },
  { key: "status", label: "Status", get: (c) => c.status },
  { key: "candidate", label: "Candidate", get: (c) => c.candidate_name || c.candidate_email || "" },
  { key: "started", label: "Started", type: "date", get: (c) => c.started_at },
  { key: "submitted", label: "Submitted", type: "date", get: (c) => c.submitted_at },
  { key: "end", label: "End", get: (c) => c.end_reason || "" },
  { key: "frames", label: "Frames", type: "number", get: (c) => c.frames ?? 0 },
  { key: "audio", label: "Audio", type: "number", get: (c) => c.audio ?? 0 },
  { key: "actions", label: "Actions", get: actionSortValue },
];

export function actionSortValue(c) {
  const parts = [];
  if (c.status === "submitted" || c.frames > 0 || (c.audio || 0) > 0) parts.push("review", "zip");
  if (c.status !== "void" && c.status !== "submitted") parts.push("void");
  return parts.join(" ");
}

function isEmpty(value, type) {
  if (type === "number") return value == null || Number.isNaN(Number(value));
  if (value == null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (type === "date") return Number.isNaN(Date.parse(value));
  return false;
}

export function compareSortValues(a, b, type = "text", dir = "asc") {
  const emptyA = isEmpty(a, type);
  const emptyB = isEmpty(b, type);
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;

  let cmp = 0;
  if (type === "number") cmp = Number(a) - Number(b);
  else if (type === "date") cmp = Date.parse(a) - Date.parse(b);
  else cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return dir === "desc" ? -cmp : cmp;
}

export function sortByColumn(rows, column, dir) {
  return rows.slice().sort((left, right) =>
    compareSortValues(column.get(left), column.get(right), column.type, dir)
  );
}

export function nextSort(current, key) {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: "asc" };
}
