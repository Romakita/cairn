import type { ScreenShot } from "./types.ts";

/** Captures de la zone « git » : dépôts, branches, worktrees, analyse au fil de l'eau et confirmations. */
export const shots: ScreenShot[] = [
  { name: "git.repos", hash: "#/app/git" },
  { name: "git.repos.fr", hash: "#/app/git", lang: "fr" },
  {
    name: "git.branches",
    hash: "#/app/git",
    before: async (page) => page.getByRole("tab", { name: "Branches" }).click(),
  },
  {
    name: "git.worktrees",
    hash: "#/app/git",
    before: async (page) => page.getByRole("tab", { name: "Worktrees" }).click(),
  },
  {
    name: "git.repo.menu",
    hash: "#/app/git",
    before: async (page) => {
      await page.getByRole("row", { name: /cairn/ }).getByRole("button", { name: "Actions" }).click();
    },
  },
  {
    name: "git.worktree.confirm",
    hash: "#/app/git",
    before: async (page) => {
      await page.getByRole("tab", { name: "Worktrees" }).click();
      await page
        .getByRole("row", { name: /menu-bar/ })
        .getByRole("button", { name: "Actions" })
        .click();
      await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
    },
  },
  {
    name: "git.trash.confirm",
    hash: "#/app/git",
    before: async (page) => {
      await page.getByRole("row", { name: /api/ }).getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Move repository to Trash…" }).click();
    },
  },
  {
    name: "git.compact.confirm",
    hash: "#/app/git",
    before: async (page) => {
      await page.getByRole("row", { name: /cairn/ }).getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Compact (git gc)…" }).click();
    },
  },
  {
    name: "git.options",
    hash: "#/app/git",
    before: async (page) => page.getByRole("button", { name: "Options…" }).click(),
  },
  { name: "git.many", hash: "#/app/git", scenario: "git-many-repos" },
  {
    name: "git.many.menu",
    hash: "#/app/git",
    scenario: "git-many-repos",
    before: async (page) => {
      await page.getByRole("tab", { name: "Branches" }).click();
      await page.getByRole("button", { name: "Actions" }).first().click();
      await page.getByRole("menuitem", { name: "Delete branch…" }).hover();
      await page.waitForTimeout(500);
    },
  },
  { name: "git.empty", hash: "#/app/git", scenario: "empty" },
];
