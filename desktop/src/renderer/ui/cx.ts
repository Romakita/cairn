/** Joint des noms de classe en ignorant les valeurs vides. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
