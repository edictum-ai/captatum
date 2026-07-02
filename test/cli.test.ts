import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { captatumSkillMarkdown, installSkill } from "../src/interfaces/mcp/skill.ts";

test("parseArgs: url positional + flags parsed", () => {
  const a = parseArgs([
    "https://x.test/a", "--output", "raw", "--prompt", "sum it",
    "--debug", "--allow-render", "--budget", "200", "--max-bytes", "1000", "--timeout-ms", "5000",
  ]);
  assert.equal(a.url, "https://x.test/a");
  assert.equal(a.output, "raw");
  assert.equal(a.prompt, "sum it");
  assert.equal(a.debug, true);
  assert.equal(a.allowRender, true);
  assert.equal(a.budget, 200);
  assert.equal(a.maxBytes, 1000);
  assert.equal(a.timeoutMs, 5000);
  assert.equal(parseArgs(["--debug"]).url, undefined); // no positional url
  assert.equal(parseArgs(["https://x.test", "https://y.test"]).url, "https://x.test"); // first positional wins
});

test("captatumSkillMarkdown: claude vs codex variants", () => {
  const claude = captatumSkillMarkdown("claude");
  assert.match(claude, /^---\nname: captatum\n/);
  assert.match(claude, /for Claude Code/);
  const codex = captatumSkillMarkdown("codex");
  assert.match(codex, /for Codex/);
  assert.ok(!/for Claude Code/.test(codex)); // codex variant must not say Claude
  // both carry the fetch examples
  assert.match(claude, /--output raw/);
  assert.match(codex, /--output raw/);
});

test("installSkill: claude writes SKILL.md, codex is idempotent (temp dir)", () => {
  const home = mkdtempSync(join(tmpdir(), "captatum-skill-"));
  try {
    // claude target → ~/.claude/skills/captatum/SKILL.md, created=true first time
    const r1 = installSkill("claude", home);
    assert.equal(r1.created, true);
    assert.equal(existsSync(join(home, ".claude", "skills", "captatum", "SKILL.md")), true);
    const r2 = installSkill("claude", home);
    assert.equal(r2.created, false); // already existed

    // codex target → AGENTS.md section; re-install must NOT duplicate the section
    installSkill("codex", home);
    const after1 = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
    installSkill("codex", home);
    const after2 = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
    assert.equal((after2.match(/BEGIN captatum skill/g) || []).length, 1, "codex install must be idempotent");
    assert.equal(after1, after2);
    assert.match(after2, /for Codex/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
