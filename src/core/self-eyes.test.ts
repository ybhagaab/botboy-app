/**
 * Self-eyes pure parts (SELF_EYES_PLAN.md): the privacy-scope route guard,
 * URL building, and the code-built inspect expression. The CDP lifecycle is
 * live-fired against the real debug Chrome, not unit-tested (no external
 * browser dependency in CI).
 */

import { describe, it, expect } from 'vitest';
import { normalizeAppRoute, appUrlForRoute, buildInspectExpression } from './self-eyes.js';

describe('normalizeAppRoute — the privacy scope guard', () => {
  it('accepts app hash routes in their common spellings', () => {
    expect(normalizeAppRoute('/dashboards')).toBe('/dashboards');
    expect(normalizeAppRoute('dashboards')).toBe('/dashboards');
    expect(normalizeAppRoute('#/dashboards/dash_abc123')).toBe('/dashboards/dash_abc123');
    expect(normalizeAppRoute('')).toBe('/');
    expect(normalizeAppRoute('/doc/aHR0cA==')).toBe('/doc/aHR0cA==');
  });

  it('rejects full URLs and foreign origins — the debug Chrome carries the owner session', () => {
    expect(() => normalizeAppRoute('https://mail.google.com')).toThrow(/full URLs/);
    expect(() => normalizeAppRoute('http://localhost:9222/json')).toThrow(/full URLs/);
    expect(() => normalizeAppRoute('file:///etc/passwd')).toThrow(/full URLs/);
    expect(() => normalizeAppRoute('/../../etc')).toThrow();
    expect(() => normalizeAppRoute('/dash boards<script>')).toThrow(/unsupported characters/);
  });

  it('appUrlForRoute always lands on the app origin', () => {
    expect(appUrlForRoute('/')).toBe('http://localhost:7778/');
    expect(appUrlForRoute('/dashboards')).toBe('http://localhost:7778/#/dashboards');
  });
});

describe('buildInspectExpression — no arbitrary JS', () => {
  it('JSON-escapes the selector so it cannot break out of the expression', () => {
    const hostile = '"; window.close(); var x = "';
    const expression = buildInspectExpression(hostile);
    // The hostile fragment must appear ONLY inside the JSON-escaped string
    // literal — removing that literal leaves no trace of it in code position.
    expect(expression).toContain(JSON.stringify(hostile));
    expect(expression.replace(JSON.stringify(hostile), '')).not.toContain('window.close');
  });

  it('produces an expression measuring rects, styles, and text', () => {
    const expression = buildInspectExpression('.analytics-vega svg.marks');
    expect(expression).toContain('getBoundingClientRect');
    expect(expression).toContain('getComputedStyle');
    expect(expression).toContain('querySelectorAll');
  });
});
