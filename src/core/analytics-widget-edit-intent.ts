import type { AnalyticsWidgetEditAction } from './analytics-types.js';

/**
 * Routing heuristics only. These patterns decide whether a chat turn gets
 * dashboard-edit context (the visible widget selection and scoped grounding).
 * They never authorize or block a write: dashboard tools rely on the live
 * owner turn plus ownerRequested, and the service validates exact targets.
 */

const DASHBOARD_ID_RE = /\bdash_[a-zA-Z0-9_-]{1,96}\b/g;
const WIDGET_ID_RE = /\bwidget_[a-zA-Z0-9_-]{1,96}\b/g;
const DEICTIC_TARGET_SOURCE = '(?:(?:this|that|these|those)\\s+(?:(?:selected|visible|current|two)\\s+)?(?:widgets?|charts?|views?|visualizations?|graphs?|figures?)|(?:the\\s+)?selected\\s+(?:widgets?|charts?|views?|visualizations?|graphs?|figures?)|both(?:\\s+(?:widgets?|charts?|views?|visualizations?|graphs?|figures?))?)';
const DEICTIC_TARGET_RE = new RegExp(`\\b${DEICTIC_TARGET_SOURCE}\\b`, 'i');
const NEGATED_OR_READ_ONLY_RE = /\b(?:do\s+not|don['’]?t|dont|never|without|not|no|nothing|neither)\b|\b(?:only\s+if|unless|until|later|maybe|perhaps|suppose|assuming|what\s+if|if\s+(?:i|you|we)|may\s+ask|might\s+ask|before\s+(?:i|you|we)|after\s+(?:i|you|we))\b|\b(?:explain|describe|preview|tell\s+me\s+(?:how|what))\b/i;
const GENERIC_WORK_RE = /\b(?:create|add|file|track|make|set|update|edit|rename|change|modify)\s+(?:me\s+)?(?:(?:a|the|this|that|my)\s+)?(?:tasks?|tickets?|reminders?|notes?|documents?|docs?|files?|work\s+items?)\b|\b(?:add|attach|put|insert)\b[^.!?\n]{0,80}\b(?:to|into)\s+(?:(?:a|the|this|that|my)\s+)?(?:tasks?|tickets?|reminders?|notes?|documents?|docs?|files?|work\s+items?)\b|\b(?:tasks?|tickets?|reminders?|notes?|documents?|docs?|files?|work\s+items?)\b[^.!?\n]{0,100}\b(?:this|that|selected)\s+(?:widgets?|charts?|views?|visualizations?|graphs?|figures?)\b[^.!?\n]{0,100}\b(?:update|edit|change|rename|make|render|switch)\b/i;
const DATE_ACTION_RE = /\b(?:change|set|show|limit|narrow|expand|update)\b/i;
const DATE_CUE_RE = /\b(?:date|range|from|through|between|last|next|month|week|year|day|quarter|today|yesterday)\b|\b\d{4}-\d{2}-\d{2}\b/i;
const ADD_ACTION_RE = /\b(?:add|clone|copy|duplicate)\b|\b(?:create|make)\b(?=[^.!?\n]{0,80}\b(?:new|another|separate|copy|duplicate)\b)/i;
const COMBINE_ACTION_RE = /\b(?:combine|stack|side[- ]by[- ]side|together|merge)\b/i;
const PRESENTATION_ACTION_RE = /\b(?:change|switch|rename|turn|make|render|recreate|update|edit)\b/i;
const PRESENTATION_CUE_RE = /\b(?:area|line|bar|point|title|subtitle|renderer|render|visual(?:ization)?|chart|graph|view|layout)\b/i;

function uniqueMatches(message: string, pattern: RegExp): string[] {
  return [...new Set(message.match(pattern) ?? [])];
}

export function analyticsWidgetEditExactIds(message: string): { dashboardIds: string[]; widgetIds: string[] } {
  return {
    dashboardIds: uniqueMatches(message, DASHBOARD_ID_RE),
    widgetIds: uniqueMatches(message, WIDGET_ID_RE),
  };
}

export function isGenericWorkArtifactRequest(message: string): boolean {
  return GENERIC_WORK_RE.test(message);
}

function directInstructionBody(message: string): string {
  let body = message.trim().replace(/\s+/g, ' ');
  body = body.replace(/^please\s*[:,]?\s+/i, '');
  body = body.replace(/^(?:on|for)\s+dash_[a-zA-Z0-9_-]{1,96}\s*[,;:]?\s*/i, '');
  body = body.replace(/^please\s*[:,]?\s+/i, '');
  body = body.replace(/^(?:can|could|would)\s+you\s+/i, '');
  body = body.replace(/^please\s*[:,]?\s+/i, '');
  return body;
}

function actionTargetsWidget(
  afterAction: string,
  action: AnalyticsWidgetEditAction | string,
  actionVerb: string,
  requireDeictic: boolean,
): boolean {
  const target = requireDeictic ? DEICTIC_TARGET_SOURCE : 'widget_[a-zA-Z0-9_-]{1,96}';
  const unrelatedDestination = /\b(?:to|into|in|inside|within|for|attached\s+to)\s+(?:(?:a|the|this|that|my)\s+)?(?:task|ticket|reminder|note|document|doc|file|work\s+item)\b/i;
  if (unrelatedDestination.test(afterAction)) return false;
  const directTargetPattern = new RegExp(`^(?:${target})\\b`, 'i');
  const directTarget = afterAction.match(directTargetPattern);
  const stripDashboardQualifier = (value: string): string => value.trimStart()
    .replace(/^(?:on|for)\s+dash_[a-zA-Z0-9_-]{1,96}\s*[,;:]?\s*/i, '');

  if (action === 'combine_compatible_widgets') {
    if (!directTarget) return false;
    if (requireDeictic) {
      return /\b(?:both|two|widgets|charts|views|visualizations|graphs|figures)\b/i.test(directTarget[0]);
    }
    const remainder = stripDashboardQualifier(afterAction.slice(directTarget[0].length));
    return /^(?:,|and\b|with\b)\s*widget_[a-zA-Z0-9_-]{1,96}\b/i.test(remainder);
  }

  if (action === 'add_from_widget') {
    if (directTarget && /^(?:clone|copy|duplicate)$/i.test(actionVerb)) {
      const remainder = stripDashboardQualifier(afterAction.slice(directTarget[0].length));
      if (/^(?:clone|duplicate)$/i.test(actionVerb) && (!remainder || /^[.!?]?$/.test(remainder))) return true;
      return /^(?:as|into)\s+(?:(?:a|an)\s+)?(?:(?:new|another|separate|duplicate|copied)\s+){0,2}(?:(?:line|bar|area|point)\s+)?(?:widget|chart|view|visualization)\b/i.test(remainder);
    }
    const newViewFromTarget = afterAction.match(new RegExp(
      `^(?:(?:a|an)\\s+)?(?:(?:new|another|separate|duplicate|copied)\\s+){0,3}(?:(?:line|bar|area|point)\\s+)?(?:widget|chart|view|visualization)\\b[^.!?\\n]{0,80}\\b(?:from|based\\s+on|using)\\s+(?:${target})\\b`,
      'i',
    ));
    if (!newViewFromTarget) return false;
    const tail = stripDashboardQualifier(afterAction.slice(newViewFromTarget[0].length));
    return !/\b(?:to|into|for)\s+(?:(?:a|the|this|that|my)\s+)?(?:task|ticket|reminder|note|document|doc|file|work\s+item)\b/i.test(tail);
  }

  const property = action === 'date_range'
    ? '(?:date\\s+range|range|dates?)'
    : '(?:title|subtitle|renderer|visualization|view|chart|layout)';
  const propertyOfTarget = afterAction.match(new RegExp(`^(?:the\\s+)?(${property})\\s+(?:of|for|on)\\s+(?:${target})\\b`, 'i'));
  if (propertyOfTarget) {
    const remainder = stripDashboardQualifier(afterAction.slice(propertyOfTarget[0].length));
    return action === 'date_range'
      ? DATE_CUE_RE.test(remainder)
      : /^(?:to|into|as)\s+\S/i.test(remainder);
  }
  if (!directTarget) return false;
  const remainder = stripDashboardQualifier(afterAction.slice(directTarget[0].length));
  if (action === 'date_range') {
    return /^(?:['’]s\s+)?(?:date\s+range|range|dates?)\b/i.test(remainder)
      || /^(?:to|for|from|between)\b/i.test(remainder) && DATE_CUE_RE.test(remainder);
  }
  if (/^(?:['’]s\s+)?(?:title|subtitle)\s+(?:to|as)\s+\S/i.test(remainder)) return true;
  if (/^(?:renderer|visualization|view|chart|layout)\s+(?:to|into|as)\s+(?:area|line|bar|point|vconcat|hconcat)\b/i.test(remainder)) return true;
  if (/^(?:to|into|as)\s+(?:(?:a|an|the)\s+)?(?:area|line|bar|point)\b/i.test(remainder)) return true;
  return /^(?:rename)$/i.test(actionVerb) && /^(?:to|as)\s+\S/i.test(remainder);
}

export function analyticsWidgetEditActionAllowed(
  message: string,
  action: AnalyticsWidgetEditAction | string,
  options: { requireDeictic?: boolean } = {},
): boolean {
  const text = message.trim();
  if (!text || NEGATED_OR_READ_ONLY_RE.test(text) || isGenericWorkArtifactRequest(text)) return false;
  const body = directInstructionBody(text);
  const actionPattern = action === 'combine_compatible_widgets'
    ? COMBINE_ACTION_RE
    : action === 'add_from_widget'
      ? ADD_ACTION_RE
      : action === 'date_range'
        ? DATE_ACTION_RE
        : action === 'presentation'
          ? PRESENTATION_ACTION_RE
          : null;
  if (!actionPattern) return false;
  const actionMatch = body.match(actionPattern);
  if (!actionMatch || actionMatch.index !== 0) return false;
  if (action === 'date_range' && !DATE_CUE_RE.test(body)) return false;
  if (action === 'presentation' && DATE_CUE_RE.test(body) && !PRESENTATION_CUE_RE.test(body)) return false;
  const afterAction = body.slice(actionMatch[0].length).trimStart();
  return actionTargetsWidget(afterAction, action, actionMatch[0], options.requireDeictic === true);
}

export function routeAnalyticsWidgetEditAction(message: string): AnalyticsWidgetEditAction | undefined {
  if (!DEICTIC_TARGET_RE.test(message) || NEGATED_OR_READ_ONLY_RE.test(message) || isGenericWorkArtifactRequest(message)) return undefined;
  const ordered: AnalyticsWidgetEditAction[] = [
    'combine_compatible_widgets',
    'add_from_widget',
    'date_range',
    'presentation',
  ];
  return ordered.find(action => analyticsWidgetEditActionAllowed(message, action, { requireDeictic: true }));
}

export function analyticsWidgetEditSelectionCount(action: AnalyticsWidgetEditAction | string): 1 | 2 {
  return action === 'combine_compatible_widgets' ? 2 : 1;
}