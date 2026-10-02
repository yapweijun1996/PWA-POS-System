import { readFile } from "node:fs/promises";

export async function secret(name: string, required = true) {
  const direct = process.env[name],
    file = process.env[name + "_FILE"];
  if (direct && file) throw new Error(`Provide exactly one ${name} source`);
  const value = file
    ? (await readFile(file, "utf8")).replace(/\r?\n$/, "")
    : direct;
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}
