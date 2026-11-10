/** The reader's choice of sheet. Dark unless they have asked for light. */
export type Theme = "dark" | "light";

export const THEME_COOKIE = "theme";

export function parseTheme(value: string | undefined): Theme {
  return value === "light" ? "light" : "dark";
}
