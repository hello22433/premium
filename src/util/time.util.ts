export function normalizeDate(date: Date | null): Date | null {
  if (date === null) {
    return null;
  }

  const parsedDate = date;
  const thresholdDate = new Date('1970-01-01T00:00:00');

  if (parsedDate <= thresholdDate) {
    return null;
  }

  return date;
}
