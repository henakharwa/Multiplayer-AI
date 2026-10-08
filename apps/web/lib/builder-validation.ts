export function missingRequiredFields(fields: Record<string, string | null | undefined>) {
  return Object.entries(fields)
    .filter(([, value]) => !value?.trim())
    .map(([field]) => field);
}
