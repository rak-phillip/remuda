/**
 * How long ago something was created, in the compact form a list column wants.
 *
 * Deliberately not a duration library: the list needs one coarse figure at a
 * glance, and "2d" beside a branch name reads faster than "2 days ago". The
 * units step rather than combine -- 25 hours is "1d", not "1d 1h" -- because
 * the question a reader is answering is "is this one old", not "how old".
 */
export function relativeAge(createdAt?: string, now: number = Date.now()): string {
  if (!createdAt) {
    return '';
  }

  const then = Date.parse(createdAt);

  if (Number.isNaN(then)) {
    return '';
  }

  const seconds = Math.floor((now - then) / 1000);

  // A clock skewed a little between the browser and the cluster would otherwise
  // render a negative age, which reads as a bug rather than as a rounding.
  if (seconds < 60) {
    return '<1m';
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${ minutes }m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${ hours }h`;
  }

  return `${ Math.floor(hours / 24) }d`;
}
