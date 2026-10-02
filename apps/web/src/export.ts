import { download } from "./components.tsx";
export function exportCsv(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (value: unknown) => {
    let text =
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    if (typeof value === "string" && /^[=+@\-\t\r]/.test(text))
      text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const content = [
    columns.map(cell).join(","),
    ...rows.map((r) => columns.map((c) => cell(r[c])).join(",")),
  ].join("\r\n");
  download(
    name,
    new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" }),
  );
}
