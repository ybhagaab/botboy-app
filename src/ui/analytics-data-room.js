function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function controlsFor(widget) {
  return widget?.controls && widget?.binding ? widget.controls : null;
}

export function analyticsControlExpected(widget) {
  const controls = controlsFor(widget);
  if (!controls) return null;
  return {
    widgetRevision: widget.revision,
    bindingRevision: widget.binding.revision,
    controlRevision: controls.controlRevision,
    controlValuesSha256: controls.currentValuesSha256,
    controlDefinitionSha256: controls.definitionSha256,
    datasetDefinitionRevision: controls.definition.datasetDefinitionRevision,
    datasetDefinitionSha256: controls.definition.datasetDefinitionSha256,
    contractSha256: controls.definition.contractSha256,
  };
}

export function analyticsControlBaseKey(widget) {
  const expected = analyticsControlExpected(widget);
  return expected ? JSON.stringify(expected) : '';
}

function filterInput(filter) {
  return {
    field: String(filter?.field || ''),
    operator: String(filter?.operator || 'eq'),
    valueText: Array.isArray(filter?.value)
      ? filter.value.map(value => value == null ? 'null' : String(value)).join(', ')
      : filter?.value == null ? '' : String(filter.value),
  };
}

export function createAnalyticsControlDraft(widget) {
  const controls = controlsFor(widget);
  const expected = analyticsControlExpected(widget);
  if (!controls || !expected) return null;
  return {
    baseKey: JSON.stringify(expected),
    expected,
    definitionSha256: controls.definitionSha256,
    dateRange: clone(controls.currentValues.dateRange),
    filters: (controls.currentValues.filters || []).map(filterInput),
    sort: clone(controls.currentValues.sort),
    dirty: false,
    conflict: false,
    definitionChanged: false,
  };
}

/** Keep owner values across repaint; only pristine state auto-advances. */
export function reconcileAnalyticsControlDraft(existing, widget) {
  const canonical = createAnalyticsControlDraft(widget);
  if (!canonical) return null;
  if (!existing) return canonical;
  if (existing.baseKey === canonical.baseKey) return existing;
  if (!existing.dirty) return canonical;
  return {
    ...existing,
    baseKey: canonical.baseKey,
    expected: canonical.expected,
    conflict: true,
    definitionChanged: existing.definitionSha256 !== canonical.definitionSha256,
  };
}

function scalar(text, logicalType, label) {
  const value = String(text ?? '').trim();
  if (logicalType === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${label} must be true or false.`);
  }
  if (logicalType === 'integer') {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a whole number.`);
    return parsed;
  }
  if (logicalType === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
    return parsed;
  }
  return value;
}

function filterValue(filter, definition, index) {
  const field = (definition?.filters || []).find(item => item.field === filter.field);
  if (!field || !field.operators.includes(filter.operator)) {
    throw new Error(`Filter ${index + 1} is no longer allowed by this dataset definition.`);
  }
  const label = `Filter ${index + 1}`;
  if (filter.operator === 'in' || filter.operator === 'between') {
    const values = String(filter.valueText ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (!values.length) throw new Error(`${label} needs at least one value.`);
    if (filter.operator === 'between' && values.length !== 2) {
      throw new Error(`${label} BETWEEN needs exactly two comma-separated values.`);
    }
    return values.map(value => scalar(value, field.logicalType, label));
  }
  return scalar(filter.valueText, field.logicalType, label);
}

export function materializeAnalyticsControlValues(draft, definition) {
  if (!draft) throw new Error('Control draft is unavailable.');
  const sort = draft.sort?.field
    ? { field: String(draft.sort.field), direction: draft.sort.direction === 'desc' ? 'desc' : 'asc' }
    : null;
  return {
    version: 1,
    dateRange: { start: String(draft.dateRange?.start || ''), end: String(draft.dateRange?.end || '') },
    filters: (draft.filters || []).map((filter, index) => ({
      field: String(filter.field || ''),
      operator: String(filter.operator || 'eq'),
      value: filterValue(filter, definition, index),
    })),
    sort,
  };
}

export function buildAnalyticsControlApplyPayload(widget, draft) {
  const controls = controlsFor(widget);
  if (!controls || !draft?.expected) throw new Error('Reload this widget before applying controls.');
  if (draft.definitionChanged) throw new Error('The dataset definition changed. Reset the draft before applying.');
  return {
    expected: clone(draft.expected),
    controls: materializeAnalyticsControlValues(draft, controls.definition),
  };
}

function compareCell(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType !== rightType) return leftType.localeCompare(rightType);
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

export function sortAnalyticsShownRows(rows, columnIndex, direction = 'asc') {
  if (!Array.isArray(rows) || !Number.isInteger(columnIndex) || columnIndex < 0) return Array.isArray(rows) ? [...rows] : [];
  const multiplier = direction === 'desc' ? -1 : 1;
  return rows.map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftValue = left.row?.[columnIndex];
      const rightValue = right.row?.[columnIndex];
      if (leftValue == null && rightValue == null) return left.index - right.index;
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      return compareCell(leftValue, rightValue) * multiplier || left.index - right.index;
    })
    .map(item => item.row);
}

export function nextAnalyticsShownSort(current, columnIndex) {
  if (!current || current.columnIndex !== columnIndex) return { columnIndex, direction: 'asc' };
  if (current.direction === 'asc') return { columnIndex, direction: 'desc' };
  return null;
}
