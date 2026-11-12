import { expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, updateTag: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: () => {} }));

const { withParam } = await import("./admin-action");

test("withParam adds to a path with or without a query, replaces an old notice, and keeps the hash last", () => {
  expect(withParam("/admin", "done", "Saved")).toBe("/admin?done=Saved");
  expect(withParam("/admin/agents/name?call=119", "error", "No such call")).toBe("/admin/agents/name?call=119&error=No+such+call");
  expect(withParam("/admin/agents/name?done=Old&status=failed", "done", "New")).toBe("/admin/agents/name?status=failed&done=New");
  expect(withParam("/admin/agents/watch#incident-4", "done", "Marked resolved")).toBe("/admin/agents/watch?done=Marked+resolved#incident-4");
});
