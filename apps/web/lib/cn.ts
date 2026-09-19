/** Joins class names, dropping falsy values - the one bit of shadcn's `cn` this project needs without pulling in Tailwind's merge logic. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
