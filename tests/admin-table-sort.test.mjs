import test from "node:test";
import assert from "node:assert/strict";
import { CODE_COLUMNS, compareSortValues, nextSort, sortByColumn } from "../client/src/admin-table-sort.js";

test("compareSortValues keeps empty values last in both directions", () => {
  assert.equal(compareSortValues("", "B", "text", "asc"), 1);
  assert.equal(compareSortValues("", "B", "text", "desc"), 1);
  assert.equal(compareSortValues("2026-01-02", "", "date", "desc"), -1);
});

test("compareSortValues sorts text, numbers and dates", () => {
  assert.ok(compareSortValues("U99T6T", "A12B3C", "text", "asc") > 0);
  assert.ok(compareSortValues(12, 3, "number", "desc") < 0);
  assert.ok(compareSortValues("2026-09-12T10:00:00Z", "2026-09-11T10:00:00Z", "date", "desc") < 0);
});

test("nextSort starts ascending then toggles", () => {
  assert.deepEqual(nextSort({ key: null, dir: "asc" }, "status"), { key: "status", dir: "asc" });
  assert.deepEqual(nextSort({ key: "status", dir: "asc" }, "status"), { key: "status", dir: "desc" });
  assert.deepEqual(nextSort({ key: "status", dir: "desc" }, "frames"), { key: "frames", dir: "asc" });
});

test("sortByColumn orders issued-code rows by any column", () => {
  const rows = [
    { code: "B2", assessment_title: "Backend", status: "unused", candidate_name: "", started_at: null, submitted_at: null, end_reason: null, frames: 0, audio: 0 },
    { code: "A1", assessment_title: "Frontend", status: "submitted", candidate_name: "Zed", started_at: "2026-09-10T12:00:00Z", submitted_at: "2026-09-10T12:20:00Z", end_reason: "submitted", frames: 40, audio: 2 },
    { code: "C3", assessment_title: "Backend", status: "active", candidate_name: "Ann", started_at: "2026-09-12T09:00:00Z", submitted_at: null, end_reason: null, frames: 5, audio: 0 },
  ];
  const by = (key, dir) => sortByColumn(rows, CODE_COLUMNS.find((c) => c.key === key), dir).map((r) => r.code);

  assert.deepEqual(by("code", "asc"), ["A1", "B2", "C3"]);
  assert.deepEqual(by("status", "asc"), ["active", "submitted", "unused"].map((status) => rows.find((r) => r.status === status).code));
  assert.deepEqual(by("candidate", "asc"), ["C3", "A1", "B2"]);
  assert.deepEqual(by("frames", "desc"), ["A1", "C3", "B2"]);
  assert.deepEqual(by("started", "desc"), ["C3", "A1", "B2"]);
  assert.equal(CODE_COLUMNS.length, 11);
});
