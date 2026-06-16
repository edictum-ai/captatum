import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { config } from "../config.ts";

const maxLines = config.source.maxFileLines;
const root = join(process.cwd(), "src");
const failures: string[] = [];

for (const filePath of listTypeScriptFiles(root)) {
  const text = readFileSync(filePath, "utf8");
  const lineCount = text.endsWith("\n")
    ? text.split("\n").length - 1
    : text.split("\n").length;

  if (lineCount > maxLines) {
    failures.push(`${relative(process.cwd(), filePath)} has ${lineCount} lines`);
  }
}

if (failures.length > 0) {
  console.error(`TypeScript files must stay at or below ${maxLines} lines.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
}

function* listTypeScriptFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* listTypeScriptFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield entryPath;
    }
  }
}
