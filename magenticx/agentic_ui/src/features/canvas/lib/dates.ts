/**
 * How the canvas writes a version's date: the day in the byline ("18 Nov
 * 2026"), the day and time in the version menu, both in the browser's locale.
 * An unparsable timestamp is written as nothing rather than "Invalid Date".
 */
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const MOMENT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const format = (formatter: Intl.DateTimeFormat, iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatter.format(date);
};

/** "18 Nov 2026" (locale order), or "" for a bad timestamp. */
export const formatVersionDay = (iso: string): string => format(DAY, iso);

/** "18 Nov, 09:40" (locale order), or "" for a bad timestamp. */
export const formatVersionMoment = (iso: string): string => format(MOMENT, iso);
