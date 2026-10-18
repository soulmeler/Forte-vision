export function isCompletedResult(value) {
  if (!value || !Array.isArray(value.violations)) return false;
  if (value.verdict === 'review_required') return value.review_required === true
    && value.violations.length === 0 && Array.isArray(value.observed_events)
    && typeof value.analysis?.coverage?.complete === 'boolean';
  return value.verdict === 'violation' ? value.violations.length > 0
    : value.verdict === 'no_violation' && value.violations.length === 0;
}

export function resultEvents(value) {
  const events = value?.verdict === 'review_required' ? value.observed_events : value?.violations;
  return Array.isArray(events) ? events : [];
}
