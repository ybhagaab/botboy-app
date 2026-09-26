type JsonSchema = Record<string, unknown>;

const IDENTIFIER_PATTERN = '^[A-Za-z_][A-Za-z0-9_]{0,159}$';
const SOURCE_ALIAS_PATTERN = '^[A-Za-z][A-Za-z0-9_]{0,31}$';
const SHA256_PATTERN = '^[a-f0-9]{64}$';
const ISO_DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

function scalarSchema(): JsonSchema {
  return {
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
    ],
    description: 'One JSON scalar. Numbers must be finite.',
  };
}

function identifierSchema(description: string): JsonSchema {
  return { type: 'string', pattern: IDENTIFIER_PATTERN, maxLength: 160, description };
}

function uniqueIdentifiers(description: string, minimum = 0, maximum = 128): JsonSchema {
  return {
    type: 'array',
    minItems: minimum,
    maxItems: maximum,
    uniqueItems: true,
    items: identifierSchema('Exact field or relation identifier.'),
    description,
  };
}

function fieldSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 160, description: 'Exact source/output column name.' },
      logicalType: { type: 'string', enum: ['string', 'integer', 'number', 'boolean', 'date', 'timestamp'] },
      physicalType: { type: 'string', minLength: 1, maxLength: 160, description: 'Optional source-system type label.' },
      nullable: { type: 'boolean' },
    },
    required: ['name', 'logicalType', 'nullable'],
  };
}

function exactMetricSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 160 },
      version: { type: 'string', minLength: 1, maxLength: 80 },
      unit: { type: 'string', minLength: 1, maxLength: 160 },
      definitionSha256: {
        type: 'string',
        pattern: SHA256_PATTERN,
        description: 'Exact lowercase semantic-definition SHA-256. For a new source, copy the metric identity returned by action=derive_semantic_hashes.',
      },
    },
    required: ['id', 'version', 'unit', 'definitionSha256'],
  };
}

function exactRegimeSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 160 },
      version: { type: 'string', minLength: 1, maxLength: 80 },
      definitionSha256: {
        type: 'string',
        pattern: SHA256_PATTERN,
        description: 'Exact lowercase semantic-definition SHA-256. For a new source, copy the regime identity returned by action=derive_semantic_hashes.',
      },
    },
    required: ['id', 'version', 'definitionSha256'],
  };
}

function metricDefinitionSchema(): JsonSchema {
  return {
    type: 'object', additionalProperties: false,
    description: 'Complete model-authored metric semantics. action=derive_semantic_hashes deterministically returns its exact request identity; it never writes or completes a plan.',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 160 },
      version: { type: 'string', minLength: 1, maxLength: 80 },
      unit: { type: 'string', minLength: 1, maxLength: 160 },
      definition: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    required: ['id', 'version', 'unit', 'definition'],
  };
}

function regimeDefinitionSchema(): JsonSchema {
  return {
    type: 'object', additionalProperties: false,
    description: 'Complete model-authored measurement-regime semantics. action=derive_semantic_hashes deterministically returns its exact request identity; it never writes or completes a plan.',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 160 },
      version: { type: 'string', minLength: 1, maxLength: 80 },
      definition: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    required: ['id', 'version', 'definition'],
  };
}

function requestFilterSchema(): JsonSchema {
  const scalar = scalarSchema();
  const base = {
    field: identifierSchema('Exact field to filter.'),
    operator: { type: 'string', enum: ['eq', 'in', 'gte', 'lte', 'between'] },
  };
  return {
    oneOf: [
      {
        type: 'object', additionalProperties: false,
        properties: { ...base, operator: { type: 'string', enum: ['eq', 'gte', 'lte'] }, value: scalar },
        required: ['field', 'operator', 'value'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          ...base,
          operator: { type: 'string', enum: ['in'] },
          value: { type: 'array', minItems: 1, maxItems: 100, items: scalar },
        },
        required: ['field', 'operator', 'value'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          ...base,
          operator: { type: 'string', enum: ['between'] },
          value: { type: 'array', minItems: 2, maxItems: 2, items: scalar },
        },
        required: ['field', 'operator', 'value'],
      },
    ],
  };
}

function derivedFilterSchema(): JsonSchema {
  const schema = requestFilterSchema();
  return {
    ...schema,
    description: 'Closed derivation predicate. Only eq may compare null; code verifies field/type compatibility.',
  };
}

function freshnessSchema(): JsonSchema {
  return {
    oneOf: [
      {
        type: 'object', additionalProperties: false,
        properties: { mode: { type: 'string', enum: ['historical_as_of'] } },
        required: ['mode'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: { mode: { type: 'string', enum: ['allow_stale'] } },
        required: ['mode'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['fresh_by'] },
          maxAgeMs: { type: 'number', minimum: 0 },
        },
        required: ['mode', 'maxAgeMs'],
      },
    ],
  };
}

function analyticsRequestSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Exact semantic request the terminal dataset must satisfy. For a newly declared source, copy metric/regime identities from action=derive_semantic_hashes and ensure the date range is fully observed; complete coverage may honestly exclude partial periods.',
    properties: {
      domainKey: { type: 'string', minLength: 1, maxLength: 160 },
      metric: exactMetricSchema(),
      dimensions: uniqueIdentifiers('Requested output dimensions.', 0, 128),
      filters: { type: 'array', maxItems: 20, items: requestFilterSchema() },
      dateRange: {
        type: 'object', additionalProperties: false,
        properties: {
          start: { type: 'string', pattern: ISO_DAY_PATTERN },
          end: { type: 'string', pattern: ISO_DAY_PATTERN },
        },
        required: ['start', 'end'],
      },
      timeZone: { type: 'string', minLength: 1, maxLength: 160, description: 'Exact IANA time zone, for example UTC.' },
      countingKey: identifierSchema('Exact row/counting key.'),
      regime: exactRegimeSchema(),
      requiredGrain: { type: 'string', minLength: 1, maxLength: 160 },
      freshness: freshnessSchema(),
      use: { type: 'string', enum: ['local_answer'], description: 'Dataset preparation always validates for local_answer use.' },
      datasetId: { type: 'string', pattern: '^ds_[A-Za-z0-9_-]{1,96}$', description: 'Optional exact existing/target dataset pin.' },
      versionId: { type: 'string', pattern: '^dsv_[a-f0-9]{24}$', description: 'Optional exact existing version pin.' },
      resultLimit: { type: 'integer', minimum: 1, maximum: 200 },
      unresolvedSemantics: {
        type: 'array', maxItems: 20, uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 160 },
        description: 'Must be empty or omitted before creating a reusable dataset.',
      },
      requiredContractSha256: { type: 'string', pattern: SHA256_PATTERN },
    },
    required: ['domainKey', 'metric', 'dimensions', 'filters', 'dateRange', 'timeZone', 'countingKey', 'regime', 'requiredGrain', 'freshness', 'use'],
  };
}

function coverageSchema(): JsonSchema {
  const day = { type: 'string', pattern: ISO_DAY_PATTERN };
  const ranges = {
    type: 'array', minItems: 1, maxItems: 128,
    items: {
      type: 'object', additionalProperties: false,
      properties: { start: day, end: day },
      required: ['start', 'end'],
    },
  };
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        description: 'Explicit coverage form for small or non-contiguous canonical partition sets. Month partition keys use YYYY-MM-01.',
        properties: {
          partitionKind: { type: 'string', enum: ['day', 'month'], description: 'Canonical coverage key granularity. Month keys use YYYY-MM-01.' },
          observedPartitions: {
            type: 'array', maxItems: 10000, uniqueItems: true, items: day,
            description: 'Every canonical partition actually represented by source evidence, including partial periods.',
          },
          completePartitions: {
            type: 'array', maxItems: 10000, uniqueItems: true, items: day,
            description: 'Only canonical partitions proven complete; each must also be observed.',
          },
          watermark: { type: 'string', minLength: 1, maxLength: 80, description: 'Exact ISO timestamp through which source evidence is current.' },
        },
        required: ['partitionKind', 'completePartitions', 'watermark'],
      },
      {
        type: 'object',
        additionalProperties: false,
        description: 'Compact coverage form. Code deterministically expands each inclusive partition range before admission; this is not server-authored planning. For partitionKind=month, use YYYY-MM-01 range endpoints. Use observedRanges for all represented partitions and completeRanges only for proven-complete partitions. Ranges may be disjoint and must expand to at most 10,000 unique keys.',
        properties: {
          partitionKind: { type: 'string', enum: ['day', 'month'], description: 'Canonical coverage key granularity. Month keys use YYYY-MM-01.' },
          observedRanges: { ...ranges, description: 'Inclusive ranges for all observed source partitions, including partial periods.' },
          completeRanges: { ...ranges, description: 'Inclusive ranges containing only proven-complete source partitions.' },
          watermark: { type: 'string', minLength: 1, maxLength: 80, description: 'Exact ISO timestamp through which source evidence is current.' },
        },
        required: ['partitionKind', 'observedRanges', 'completeRanges', 'watermark'],
      },
    ],
    description: 'Coverage must use exactly one explicit-partition or compact-range form. Dataset preparation may include observed but incomplete partitions; request.dateRange must be fully observed, while completeRanges/completePartitions state the stricter completeness truth.',
  };
}

function answerRecipeSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { type: 'integer', enum: [1] },
      metricId: { type: 'string', minLength: 1, maxLength: 160 },
      metricValueColumn: identifierSchema('Numeric metric-value field.'),
      rowDimensions: uniqueIdentifiers('Dimensions already represented by each row.', 0, 128),
      filterableFields: uniqueIdentifiers('Fields safe for exact filtering; include the contract time field and every request filter field.', 0, 128),
      stableOrder: {
        type: 'array', maxItems: 128,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            field: identifierSchema('Schema field used for stable ordering.'),
            direction: { type: 'string', enum: ['asc', 'desc'] },
          },
          required: ['field', 'direction'],
        },
      },
    },
    required: ['version', 'metricId', 'metricValueColumn', 'rowDimensions', 'filterableFields', 'stableOrder'],
  };
}

function relationalSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { type: 'integer', enum: [1] },
      grainFields: uniqueIdentifiers('Fields defining one output row.', 1, 128),
      uniqueKeys: {
        type: 'array', minItems: 1, maxItems: 32,
        items: uniqueIdentifiers('One exact unique-key field set.', 1, 128),
      },
      measures: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            field: identifierSchema('Numeric measure field.'),
            unit: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_/% -]{0,159}$' },
            aggregation: { type: 'string', enum: ['none', 'sum', 'min', 'max'] },
            protected: { type: 'boolean' },
          },
          required: ['field', 'unit', 'aggregation', 'protected'],
        },
      },
    },
    required: ['version', 'grainFields', 'uniqueKeys', 'measures'],
  };
}

function retentionSchema(): JsonSchema {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      minimumVersions: { type: 'integer', minimum: 1 },
      automaticExpiry: { type: 'boolean' },
      reacquirable: { type: 'boolean' },
      backupRequired: { type: 'boolean' },
    },
    required: ['minimumVersions', 'automaticExpiry', 'reacquirable', 'backupRequired'],
  };
}

function qualitySchema(): JsonSchema {
  const scalar = scalarSchema();
  return {
    type: 'object', additionalProperties: false,
    properties: {
      assertionId: { type: 'string', minLength: 1, maxLength: 160 },
      assertionVersion: { type: 'string', minLength: 1, maxLength: 80 },
      severity: { type: 'string', enum: ['warning', 'error'] },
      success: { type: 'boolean' },
      observed: scalar,
      expected: { oneOf: [scalar, { type: 'array', maxItems: 100, items: scalar }] },
    },
    required: ['assertionId', 'assertionVersion', 'severity', 'success'],
  };
}

function sourceTargetSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Complete target contract for a fresh SQL, ETL, or BotBoy CSV source. Columns must exactly match acquired source order and types.',
    properties: {
      datasetId: { type: 'string', pattern: '^ds_[A-Za-z0-9_-]{1,96}$', description: 'Optional exact target dataset ID. Omit to create one deterministically.' },
      expectedHeadRevision: { type: 'integer', minimum: 0, description: 'Optional exact CAS revision when updating a known dataset.' },
      name: { type: 'string', minLength: 1, maxLength: 240 },
      description: { type: 'string', minLength: 1, maxLength: 4000 },
      domainKey: { type: 'string', minLength: 1, maxLength: 160 },
      schema: { type: 'array', minItems: 1, maxItems: 200, items: fieldSchema() },
      metric: metricDefinitionSchema(),
      regime: regimeDefinitionSchema(),
      countingKey: identifierSchema('Schema field used as the counting key.'),
      grain: { type: 'string', minLength: 1, maxLength: 160 },
      availableDimensions: uniqueIdentifiers('Schema fields available as dimensions.', 0, 100),
      timeField: identifierSchema('Non-nullable date/timestamp schema field.'),
      timeZone: { type: 'string', minLength: 1, maxLength: 160 },
      coverage: coverageSchema(),
      answer: answerRecipeSchema(),
      relational: relationalSchema(),
      classification: { type: 'string', enum: ['public', 'internal', 'confidential', 'highly_confidential', 'restricted', 'critical'] },
      allowPublication: { type: 'boolean' },
      retention: retentionSchema(),
      quality: { type: 'array', maxItems: 200, items: qualitySchema(), description: 'Optional already-observed quality evidence; omit rather than inventing checks.' },
    },
    required: ['name', 'description', 'domainKey', 'schema', 'metric', 'regime', 'countingKey', 'grain', 'availableDimensions', 'timeField', 'timeZone', 'coverage', 'answer'],
  };
}

function aggregateMeasureSchema(): JsonSchema {
  const common = {
    operation: { type: 'string', enum: ['sum', 'count_rows', 'count_non_null', 'count_distinct', 'min', 'max'] },
    field: identifierSchema('Input field; omit only for count_rows.'),
    as: identifierSchema('Output field name.'),
    outputType: { type: 'string', enum: ['integer', 'number'] },
    unit: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_/% -]{0,159}$' },
  };
  return {
    type: 'object', additionalProperties: false,
    properties: common,
    required: ['operation', 'as', 'outputType', 'unit'],
    oneOf: [
      { properties: { operation: { type: 'string', enum: ['count_rows'] } }, not: { required: ['field'] } },
      { properties: { operation: { type: 'string', enum: ['sum', 'count_non_null', 'count_distinct', 'min', 'max'] } }, required: ['field'] },
    ],
  };
}

function derivedStepSchema(): JsonSchema {
  const mapping = {
    type: 'object', additionalProperties: false,
    properties: { field: identifierSchema('Input field.'), as: identifierSchema('Output field alias.') },
    required: ['field', 'as'],
  };
  const projectMapping = {
    type: 'object', additionalProperties: false,
    properties: { field: identifierSchema('Input field.'), as: identifierSchema('Optional output field alias.') },
    required: ['field'],
  };
  return {
    oneOf: [
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: identifierSchema('Unique step relation ID.'), type: { type: 'string', enum: ['filter'] },
          input: identifierSchema('Dependency alias or earlier step ID.'),
          predicates: { type: 'array', minItems: 1, maxItems: 20, items: derivedFilterSchema() },
        },
        required: ['id', 'type', 'input', 'predicates'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: identifierSchema('Unique step relation ID.'), type: { type: 'string', enum: ['join'] },
          left: identifierSchema('Left dependency/earlier-step relation.'), right: identifierSchema('Right dependency/earlier-step relation.'),
          joinType: { type: 'string', enum: ['inner', 'left'] },
          leftKeys: uniqueIdentifiers('Left join keys.', 1, 128), rightKeys: uniqueIdentifiers('Right join keys in matching order.', 1, 128),
          cardinality: { type: 'string', enum: ['one_to_one', 'many_to_one', 'one_to_many'] },
          rightFields: { type: 'array', minItems: 1, maxItems: 128, items: mapping },
          nullKeys: { type: 'string', enum: ['error', 'drop'] }, unmatched: { type: 'string', enum: ['allow', 'error'] },
          maxFanout: { type: 'integer', minimum: 1, maximum: 1000 },
        },
        required: ['id', 'type', 'left', 'right', 'joinType', 'leftKeys', 'rightKeys', 'cardinality', 'rightFields', 'nullKeys', 'unmatched', 'maxFanout'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: identifierSchema('Unique step relation ID.'), type: { type: 'string', enum: ['aggregate'] },
          input: identifierSchema('Dependency alias or earlier step ID.'), groupBy: uniqueIdentifiers('Grouping fields; empty means one aggregate row.', 0, 128),
          measures: { type: 'array', minItems: 1, maxItems: 32, items: aggregateMeasureSchema() },
        },
        required: ['id', 'type', 'input', 'groupBy', 'measures'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: identifierSchema('Unique step relation ID.'), type: { type: 'string', enum: ['ratio'] },
          input: identifierSchema('Dependency alias or earlier step ID.'), numerator: identifierSchema('Numeric numerator field.'),
          denominator: identifierSchema('Numeric denominator field.'), as: identifierSchema('Output ratio field.'),
          scale: { type: 'integer', enum: [1, 100] }, zeroDenominator: { type: 'string', enum: ['error', 'null'] },
          unit: { type: 'string', enum: ['ratio', 'percent'] },
        },
        required: ['id', 'type', 'input', 'numerator', 'denominator', 'as', 'scale', 'zeroDenominator', 'unit'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: identifierSchema('Unique step relation ID.'), type: { type: 'string', enum: ['pivot'] },
          input: identifierSchema('Dependency alias or earlier step ID.'), groupBy: uniqueIdentifiers('Fields retained as rows.', 0, 128),
          pivotField: identifierSchema('Field whose exhaustive values become columns.'),
          values: {
            type: 'array', minItems: 1, maxItems: 32,
            items: {
              type: 'object', additionalProperties: false,
              properties: { value: scalarSchema(), as: identifierSchema('Output column for this exact category.') },
              required: ['value', 'as'],
            },
          },
          measure: {
            type: 'object', additionalProperties: false,
            properties: {
              operation: { type: 'string', enum: ['sum', 'count_rows'] },
              field: identifierSchema('Required only for sum.'), outputType: { type: 'string', enum: ['integer', 'number'] },
              unit: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_/% -]{0,159}$' },
            },
            required: ['operation', 'outputType', 'unit'],
            oneOf: [
              { properties: { operation: { type: 'string', enum: ['sum'] } }, required: ['field'] },
              { properties: { operation: { type: 'string', enum: ['count_rows'] } }, not: { required: ['field'] } },
            ],
          },
          missing: { type: 'string', enum: ['zero', 'null'] }, unexpected: { type: 'string', enum: ['error'] },
        },
        required: ['id', 'type', 'input', 'groupBy', 'pivotField', 'values', 'measure', 'missing', 'unexpected'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: identifierSchema('Unique step relation ID.'), type: { type: 'string', enum: ['cohort'] },
          input: identifierSchema('Dependency alias or earlier step ID.'), entityKey: identifierSchema('Entity key.'),
          eventTimeField: identifierSchema('Date/timestamp event field.'), timeZone: { type: 'string', minLength: 1, maxLength: 160 },
          bucket: { type: 'string', enum: ['day', 'week', 'month'] }, cohortField: identifierSchema('Output cohort field.'),
          periodField: identifierSchema('Output elapsed-period field.'), nulls: { type: 'string', enum: ['error', 'drop'] },
        },
        required: ['id', 'type', 'input', 'entityKey', 'eventTimeField', 'timeZone', 'bucket', 'cohortField', 'periodField', 'nulls'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: identifierSchema('Unique step relation ID.'), type: { type: 'string', enum: ['project'] },
          input: identifierSchema('Dependency alias or earlier step ID.'),
          fields: { type: 'array', minItems: 1, maxItems: 128, items: projectMapping },
        },
        required: ['id', 'type', 'input', 'fields'],
      },
    ],
  };
}

function fragmentContractSchema(): JsonSchema {
  return {
    type: 'object', additionalProperties: false,
    description: 'Declared output contract for a relational fragment. Coverage and handling are derived from exact inputs and must not be supplied.',
    properties: {
      contractVersion: { type: 'string', minLength: 1, maxLength: 80 },
      domainKey: { type: 'string', minLength: 1, maxLength: 160 },
      schema: { type: 'array', minItems: 1, maxItems: 128, items: fieldSchema() },
      metric: exactMetricSchema(), regime: exactRegimeSchema(),
      countingKey: identifierSchema('Inherited output counting key.'),
      unit: { type: 'string', minLength: 1, maxLength: 160 },
      grain: { type: 'string', minLength: 1, maxLength: 160 },
      availableDimensions: uniqueIdentifiers('Output dimensions.', 0, 128),
      timeField: identifierSchema('Non-nullable output date/timestamp field.'),
      timeZone: { type: 'string', minLength: 1, maxLength: 160 },
      relational: relationalSchema(),
    },
    required: ['contractVersion', 'domainKey', 'schema', 'metric', 'regime', 'countingKey', 'unit', 'grain', 'availableDimensions', 'timeField', 'timeZone', 'relational'],
  };
}

function fragmentSchema(): JsonSchema {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      version: { type: 'integer', enum: [1] },
      id: identifierSchema('Unique fragment relation ID.'),
      name: { type: 'string', minLength: 1, maxLength: 240 },
      description: { type: 'string', maxLength: 4000 },
      dependencies: {
        type: 'array', minItems: 1, maxItems: 16,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            alias: identifierSchema('Fragment-local dependency alias.'),
            sourceRef: identifierSchema('Plan source alias or earlier fragment ID.'),
            requiredColumns: uniqueIdentifiers('Exact columns required from the source relation.', 1, 128),
          },
          required: ['alias', 'sourceRef', 'requiredColumns'],
        },
      },
      steps: { type: 'array', minItems: 1, maxItems: 64, items: derivedStepSchema() },
      output: identifierSchema('Dependency alias or step ID containing the fragment output.'),
      contract: fragmentContractSchema(),
      answer: answerRecipeSchema(),
    },
    required: ['version', 'id', 'name', 'description', 'dependencies', 'steps', 'output', 'contract', 'answer'],
  };
}

function sourceSchema(): JsonSchema {
  const alias = { type: 'string', pattern: SOURCE_ALIAS_PATTERN, maxLength: 32 };
  const requiredColumns = {
    type: 'array', maxItems: 100, uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 160 },
  };
  return {
    oneOf: [
      {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['existing_version'] }, alias,
          datasetId: { type: 'string', pattern: '^ds_[A-Za-z0-9_-]{1,96}$' },
          versionId: { type: 'string', pattern: '^dsv_[a-f0-9]{24}$' },
          requiredColumns,
          expectedSchemaSha256: { type: 'string', pattern: SHA256_PATTERN },
          expectedContractSha256: { type: 'string', pattern: SHA256_PATTERN },
        },
        required: ['kind', 'alias', 'datasetId', 'versionId', 'requiredColumns', 'expectedSchemaSha256', 'expectedContractSha256'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['import_inbox'] }, alias,
          importId: { type: 'string', pattern: '^dri_[a-f0-9]{24}$' }, requiredColumns,
        },
        required: ['kind', 'alias', 'importId', 'requiredColumns'],
      },
      {
        type: 'object', additionalProperties: false,
        description: 'BotBoy CSV source mini-shape: {kind:"botboy_csv", alias:"source_alias", filename:"relative.csv", sha256:"64 lowercase hex", bytes:123, nullToken:"NULL", target:{complete target object from this schema}}. Copy filename/sha256/bytes from the final write_file receipt; arbitrary or absolute paths are rejected. Replace every illustrative value with exact evidence.',
        properties: {
          kind: { type: 'string', enum: ['botboy_csv'] }, alias,
          filename: {
            type: 'string', minLength: 5, maxLength: 500,
            pattern: '^(?!/)(?!.*\\\\)(?!\\.\\.?/)(?!.*\\/\\.\\.?\\/)(?!.*\\/\\.\\.?$)(?!.*//).+\\.[cC][sS][vV]$',
            description: 'Relative .csv filename inside BotBoy’s files workspace; absolute paths, backslashes, empty segments, and dot segments are forbidden.',
          },
          sha256: { type: 'string', pattern: SHA256_PATTERN },
          bytes: { type: 'integer', minimum: 1, maximum: 16777216 },
          nullToken: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[^,\\r\\n"\\u0000]+$', description: 'Exact token interpreted as null; empty CSV cells remain empty strings.' },
          target: sourceTargetSchema(),
        },
        required: ['kind', 'alias', 'filename', 'sha256', 'bytes', 'nullToken', 'target'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['sql_query'] }, alias,
          sql: { type: 'string', minLength: 1, maxLength: 100000, description: 'One complete read-only SELECT/WITH query.' },
          target: sourceTargetSchema(),
        },
        required: ['kind', 'alias', 'sql', 'target'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['etl_query'] }, alias,
          sql: { type: 'string', minLength: 1, maxLength: 100000, description: 'Complete warehouse query submitted through checkpointed Datanet ETL.' },
          datasetDate: { type: 'string', pattern: ISO_DAY_PATTERN },
          target: sourceTargetSchema(),
        },
        required: ['kind', 'alias', 'sql', 'target'],
      },
    ],
  };
}

export function createDatasetPreparationPlanSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Fully specified plan authored by BotBoy and validated/executed by the existing durable Data Room lifecycle. Canonical outer fields are exactly version, mode, request, sources, fragments, terminal. Never rename them to semanticRequest, relationalFragments, columns, publish_dataset, or sourceAlias. Every declared source/fragment must contribute to the terminal.',
    properties: {
      version: {
        type: 'integer', enum: [1],
        description: 'Exact JSON number 1. Never use the strings "1", "v1", or "dataset_preparation.v1".',
      },
      mode: {
        type: 'string', enum: ['dataset_preparation'],
        description: 'Exact string "dataset_preparation". Never use "closed" or combine mode with version.',
      },
      request: {
        ...analyticsRequestSchema(),
        description: 'Complete request object from this schema. It is never a prose string and the field name is exactly request.',
      },
      sources: {
        type: 'array', minItems: 1, maxItems: 8, items: sourceSchema(),
        description: 'One to eight complete source objects. The field name is exactly sources.',
      },
      fragments: {
        type: 'array', maxItems: 32, items: fragmentSchema(),
        description: 'Always present. Use [] when one source is already the terminal dataset; do not rename this field to relationalFragments.',
      },
      terminal: {
        description: 'Always present. For a direct source use exactly {"kind":"source","alias":"the_same_sources_alias"}; there is no publish_dataset terminal and no sourceAlias field.',
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['source'] },
              alias: { type: 'string', pattern: SOURCE_ALIAS_PATTERN, description: 'Must exactly equal one sources[].alias.' },
            },
            required: ['kind', 'alias'],
          },
          {
            type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['fragment'] }, fragmentId: identifierSchema('Must exactly equal one fragments[].id.') },
            required: ['kind', 'fragmentId'],
          },
        ],
      },
    },
    required: ['version', 'mode', 'request', 'sources', 'fragments', 'terminal'],
  };
}

export function createDataRoomDatasetParametersSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Exactly one of three forms: derive_semantic_hashes={action:"derive_semantic_hashes", metric:{id,version,unit,definition}, regime:{id,version,definition}}; create={action:"create", ownerRequested:true, plan:{version:1, mode:"dataset_preparation", request:{...}, sources:[...], fragments:[], terminal:{kind:"source", alias:"same_source_alias"}}}; status={action:"status", jobId:"aj_..."}. Derivation is read-only and returns exact request.metric/request.regime identities; it never authors or mutates a plan. Illustrative ellipses are not valid call values; fill every required nested field from this complete schema.',
    properties: {
      action: {
        type: 'string',
        enum: ['derive_semantic_hashes', 'create', 'status'],
        description: 'For a new target, derive both semantic hashes first, then create. Continue only materially corrected no-effect create retries within the advertised four-attempt turn budget. Use status after a jobId.',
      },
      metric: metricDefinitionSchema(),
      regime: regimeDefinitionSchema(),
      jobId: { type: 'string', pattern: '^aj_[a-f0-9]{32}$', description: 'Required only for status; exact durable ID returned by create.' },
      plan: createDatasetPreparationPlanSchema(),
      ownerRequested: { type: 'boolean', enum: [true], description: 'Required only for create and only for an explicit current owner request. This is a temporary attestation in addition to server-confirmed owner context.' },
    },
    required: ['action'],
    oneOf: [
      {
        properties: { action: { type: 'string', enum: ['derive_semantic_hashes'] } },
        required: ['metric', 'regime'],
        not: { anyOf: [{ required: ['jobId'] }, { required: ['plan'] }, { required: ['ownerRequested'] }] },
      },
      {
        properties: { action: { type: 'string', enum: ['create'] } },
        required: ['plan', 'ownerRequested'],
        not: { anyOf: [{ required: ['jobId'] }, { required: ['metric'] }, { required: ['regime'] }] },
      },
      {
        properties: { action: { type: 'string', enum: ['status'] } },
        required: ['jobId'],
        not: { anyOf: [{ required: ['plan'] }, { required: ['ownerRequested'] }, { required: ['metric'] }, { required: ['regime'] }] },
      },
    ],
  };
}
