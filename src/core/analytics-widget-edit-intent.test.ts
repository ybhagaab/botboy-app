import { describe, expect, it } from 'vitest';
import {
  analyticsWidgetEditActionAllowed,
  routeAnalyticsWidgetEditAction,
} from './analytics-widget-edit-intent.js';

// Routing only: which turns receive dashboard-edit context. Not authorization.
describe('analytics widget edit context routing', () => {
  it.each([
    ['Change this widget to an area visualization.', 'presentation'],
    ['Can you please change this selected widget to an area visualization?', 'presentation'],
    ['Change the title of this widget to Weekly trend.', 'presentation'],
    ['Set this widget date range to last month.', 'date_range'],
    ['Set the date range for this widget to last month.', 'date_range'],
    ['Create another new chart from this selected widget.', 'add_from_widget'],
    ['Duplicate this selected widget.', 'add_from_widget'],
    ['Combine these two widgets side-by-side.', 'combine_compatible_widgets'],
  ])('classifies affirmative deictic edit %s', (message, action) => {
    expect(routeAnalyticsWidgetEditAction(message)).toBe(action);
    expect(analyticsWidgetEditActionAllowed(message, action, { requireDeictic: true })).toBe(true);
  });

  it.each([
    'How many daily events happened last week?',
    'Create a task to review this chart.',
    'Update the task about this chart.',
    'Edit the document describing this chart.',
    'Add this chart to a document.',
    'Regarding the document about this selected chart, update its title.',
    'Change the title of the document about this selected chart.',
    'Change nothing about this selected widget.',
    "Change this selected widget's document title to Quarterly.",
    'Copy this selected widget to a document.',
    'Copy this selected widget as a new chart in a document.',
    'Create a new chart from this selected widget inside a document.',
    'Combine this selected widget.',
    'In the task about this selected chart, change its title.',
    'Do not change this widget; just explain it.',
    "I don’t want you to change this selected widget.",
    "Please don’t ever make this selected widget an area chart.",
    'Change this selected widget only if I approve later.',
    'I may ask you to make this selected widget an area chart later.',
    'Before I ask you to change this selected widget, explain the effect.',
    "Don't make this widget an area chart.",
    'Do not switch this widget to a bar chart.',
    'How would you change this selected widget?',
    'What if you change this widget to an area chart?',
    'Explain how to change this widget to a bar chart.',
    'Preview only what this chart would look like as an area.',
  ])('does not promote non-edit message %s', message => {
    expect(routeAnalyticsWidgetEditAction(message)).toBeUndefined();
  });
});