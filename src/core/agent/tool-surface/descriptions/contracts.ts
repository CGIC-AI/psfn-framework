export interface CanonicalToolActionContract {
  readonly id: string;
  readonly action: string;
  readonly actionField?: false;
  readonly required: readonly string[];
  readonly requiredAnyOf?: readonly (readonly string[])[];
  readonly requiredOneOf?: readonly string[];
  readonly optional: readonly string[];
  readonly rule?: string;
}

export interface CanonicalToolSurfaceContract {
  readonly purpose: string;
  readonly actions: readonly CanonicalToolActionContract[];
  readonly output: string;
  readonly guidance: string;
  readonly example: Readonly<Record<string, unknown>>;
}

export function action(
  actionName: string,
  required: readonly string[] = [],
  optional: readonly string[] = [],
  options: Pick<CanonicalToolActionContract, 'id' | 'actionField' | 'requiredAnyOf' | 'requiredOneOf' | 'rule'> = { id: actionName },
): CanonicalToolActionContract {
  return {
    id: options.id,
    action: actionName,
    required,
    optional,
    ...(options.actionField === false ? { actionField: false } : {}),
    ...(options.requiredAnyOf ? { requiredAnyOf: options.requiredAnyOf } : {}),
    ...(options.requiredOneOf ? { requiredOneOf: options.requiredOneOf } : {}),
    ...(options.rule ? { rule: options.rule } : {}),
  };
}
