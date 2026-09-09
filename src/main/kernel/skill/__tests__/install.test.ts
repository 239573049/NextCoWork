import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSkillZip } from "../install";
import { nodeHost } from "../../host";
import { scanSkills } from "../load";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function archive(
  content: string,
  name = "demo",
): { root: string; zip: string } {
  const root = mkdtempSync(join(tmpdir(), "nextcowork-install-"));
  roots.push(root);
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), content);
  const zip = join(root, "skill.zip");
  execFileSync("zip", ["-qr", zip, name], { cwd: root });
  return { root, zip };
}

describe("installSkillZip", () => {
  it("strips the archive top-level directory and atomically replaces an install", async () => {
    const first = archive("---\nname: demo\ndescription: old\n---\nold body\n");
    const installRoot = join(first.root, "installed");
    const result = await installSkillZip(first.zip, installRoot, "global");
    expect(result.name).toBe("demo");
    expect(
      readFileSync(join(installRoot, "demo", "SKILL.md"), "utf8"),
    ).toContain("old body");
    expect(existsSync(join(installRoot, "demo", "demo", "SKILL.md"))).toBe(
      false,
    );
    const scanned = await scanSkills({
      fs: nodeHost().fs,
      globalRoot: installRoot,
      projectRoot: "",
    });
    expect(scanned.skills[0]?.source.kind).toBe("zip");
    expect(scanned.skills[0]?.source.sha256).toBe(result.sha256);
  });

  it("rejects symbolic links in archives", async () => {
    const root = mkdtempSync(join(tmpdir(), "nextcowork-link-"));
    roots.push(root);
    mkdirSync(join(root, "demo"), { recursive: true });
    writeFileSync(
      join(root, "demo", "SKILL.md"),
      "---\ndescription: d\n---\nbody\n",
    );
    symlinkSync("/tmp", join(root, "demo", "escape"));
    const zip = join(root, "link.zip");
    execFileSync("zip", ["-qry", "-y", zip, "demo"], { cwd: root });
    await expect(
      installSkillZip(zip, join(root, "installed"), "global"),
    ).rejects.toThrow(/符号链接/);
  });

  it("rejects unsupported frontmatter syntax", async () => {
    const { root, zip } = archive(
      "---\ndescription: d\nunsupported: |\n---\nbody\n",
    );
    await expect(
      installSkillZip(zip, join(root, "installed"), "global"),
    ).rejects.toThrow(/frontmatter/);
  });
});
