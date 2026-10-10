import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(resolve(import.meta.dirname, "..", f), "utf8");

describe("legal pages", () => {
  for (const f of ["terms.html", "privacy.html"]) {
    it(`${f} is finished text with no placeholders or em dashes`, () => {
      const page = read(f);
      expect(page).toContain("CT Wendt Holdings LLC");
      expect(page).toMatch(/Effective date: \w+ \d{1,2}, \d{4}/);
      expect(page).not.toMatch(/\[[A-Z][A-Z ]+\]/);
      expect(page).not.toContain("—");
      // The "unverified" token badge was removed: token checks now fail closed.
      expect(page.toLowerCase()).not.toContain("unverified");
    });
  }

  it("the main page links to both", () => {
    const index = read("index.html");
    expect(index).toContain('href="terms.html"');
    expect(index).toContain('href="privacy.html"');
  });

  it("the admin page names no local file paths", () => {
    expect(read("admin.html")).not.toMatch(/\.nosync|bounce-admin-token/);
  });
});
