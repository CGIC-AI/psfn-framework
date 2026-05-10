interface ToolSchemaLike {
  name?: unknown;
  parameters?: unknown;
  inputSchema?: unknown;
}

interface RepairToolArgumentsParams {
  toolName: string;
  args: Record<string, unknown>;
  tools?: readonly unknown[];
}

type SchemaRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSchemaRecord(value: unknown): SchemaRecord | null {
  return isRecord(value) ? value : null;
}

function getToolSchema(tool: unknown): unknown {
  const candidate = isRecord(tool) ? tool as ToolSchemaLike : null;
  if (!candidate) {
    return null;
  }
  return candidate.parameters ?? candidate.inputSchema ?? null;
}

function findToolSchema(toolName: string, tools: readonly unknown[] | undefined): unknown {
  if (!tools) {
    return null;
  }
  for (const tool of tools) {
    if (isRecord(tool) && tool.name === toolName) {
      return getToolSchema(tool);
    }
  }
  return null;
}

function schemaVariants(schema: SchemaRecord): unknown[] {
  const variants: unknown[] = [];
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const value = schema[key];
    if (Array.isArray(value)) {
      variants.push(...value);
    }
  }
  return variants;
}

function schemaAcceptsArray(schema: unknown): boolean {
  const record = asSchemaRecord(schema);
  if (!record) {
    return false;
  }
  const type = record.type;
  if (type === 'array' || (Array.isArray(type) && type.includes('array'))) {
    return true;
  }
  return schemaVariants(record).some(schemaAcceptsArray);
}

function tryParseJsonArray(value: string): unknown[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function repairObjectBySchema(value: Record<string, unknown>, schema: unknown): {
  value: Record<string, unknown>;
  changed: boolean;
} {
  const record = asSchemaRecord(schema);
  const properties = asSchemaRecord(record?.properties);
  if (!properties) {
    return { value, changed: false };
  }

  let changed = false;
  const repaired: Record<string, unknown> = { ...value };
  for (const [key, propertySchema] of Object.entries(properties)) {
    const currentValue = repaired[key];
    if (typeof currentValue === 'string' && schemaAcceptsArray(propertySchema)) {
      const parsed = tryParseJsonArray(currentValue);
      if (parsed) {
        repaired[key] = parsed;
        changed = true;
      }
      continue;
    }
    if (isRecord(currentValue)) {
      const nested = repairObjectBySchema(currentValue, propertySchema);
      if (nested.changed) {
        repaired[key] = nested.value;
        changed = true;
      }
    }
  }
  return { value: changed ? repaired : value, changed };
}

export function repairStringifiedJsonArrayToolArguments(
  params: RepairToolArgumentsParams,
): Record<string, unknown> {
  const schema = findToolSchema(params.toolName, params.tools);
  if (!schema) {
    return params.args;
  }
  return repairObjectBySchema(params.args, schema).value;
}
