export const taskIdSource = String.raw`(?:M(?:0|[1-9][0-9]*)\.[0-9]{2}|K(?:0|[1-9][0-9]*)-[0-9]{3})`;
export const taskIdCaptureSource = `(${taskIdSource})`;
export const taskIdPattern = new RegExp(`^${taskIdSource}$`, 'u');
export const milestoneSource = String.raw`(?:M(?:0|[1-9][0-9]*)|K(?:0|[1-9][0-9]*))`;
export const milestonePattern = new RegExp(`^${milestoneSource}$`, 'u');

/** Return the series milestone and numeric task ordinal for a stable task ID. */
export function parseTaskId(taskId) {
  const match = /^(M(?:0|[1-9][0-9]*)|K(?:0|[1-9][0-9]*))[.-]([0-9]{2,3})$/u.exec(taskId);
  if (!match || !taskIdPattern.test(taskId)) return undefined;
  return { milestone: match[1], ordinal: Number(match[2]) };
}
