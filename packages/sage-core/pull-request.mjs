/**
 * A pull request's number: digits with no leading zero, so that "#5", "05" or a link never hides a task from merge-check
 * --pr. The PR script reads the logbook's PR cell with this same rule.
 */
export const PR = /^[1-9][0-9]*$/;
