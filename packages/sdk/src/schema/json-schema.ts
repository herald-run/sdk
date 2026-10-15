import { fieldsSchema, type Field } from './forms';
type Schema = Record<string, unknown>;
const object = (value: unknown): Schema => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a schema object.');
  return value as Schema;
};
const omit = (schema: Schema, ...keys: string[]) =>
  Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
function allowed(schema: Schema, keys: string[]) {
  for (const key of Object.keys(schema))
    if (!keys.includes(key)) throw new Error(`Unsupported JSON Schema keyword: ${key}.`);
}
export function jsonSchemaFields(input: Schema): Field[] {
  allowed(input, [
    '$schema',
    '$defs',
    'title',
    'description',
    'type',
    'properties',
    'required',
    'additionalProperties',
  ]);
  if (input.type !== 'object') throw new Error('The form schema must be an object.');
  if (input.additionalProperties !== undefined && input.additionalProperties !== false)
    throw new Error('Additional properties are not supported.');
  const properties = object(input.properties || {});
  const required = input.required === undefined ? [] : input.required;
  if (
    !Array.isArray(required) ||
    required.some((k) => typeof k !== 'string' || !Object.hasOwn(properties, k))
  )
    throw new Error('Required fields must exist in properties.');
  const defs = object(input.$defs || {});
  // Pydantic emits enums as `$defs` entries; inline them, keeping the property's own keywords.
  const resolve = (value: unknown): Schema => {
    const s = object(value);
    if (s.$ref === undefined) return s;
    const name = typeof s.$ref === 'string' && /^#\/\$defs\/([^/]+)$/.exec(s.$ref)?.[1];
    if (!name || !Object.hasOwn(defs, name))
      throw new Error('Only local $defs references are supported.');
    return { ...omit(object(defs[name]), 'title', 'description'), ...omit(s, '$ref') };
  };
  return fieldsSchema.parse(
    Object.entries(properties).map(([id, value]) => {
      let s = resolve(value);
      allowed(s, [
        'title',
        'description',
        'type',
        'enum',
        'default',
        'format',
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'minLength',
        'maxLength',
        'items',
        'minItems',
        'maxItems',
        'uniqueItems',
        'anyOf',
        'x-herald-type',
      ]);
      let nullable = false;
      if (s.anyOf) {
        if (!Array.isArray(s.anyOf) || s.anyOf.length !== 2)
          throw new Error('Only nullable scalar anyOf is supported.');
        const variants = s.anyOf.map(resolve);
        const nullType = variants.find((v) => v.type === 'null');
        const scalar = variants.find((v) => v.type !== 'null');
        if (!nullType || !scalar || Object.keys(nullType).length !== 1)
          throw new Error('Only nullable scalar anyOf is supported.');
        s = { ...omit(s, 'anyOf'), ...scalar };
        allowed(s, [
          'title',
          'description',
          'type',
          'enum',
          'default',
          'format',
          'minimum',
          'maximum',
          'exclusiveMinimum',
          'exclusiveMaximum',
          'minLength',
          'maxLength',
          'x-herald-type',
        ]);
        nullable = true;
      }
      if (Array.isArray(s.type)) {
        if (s.type.length !== 2 || !s.type.includes('null'))
          throw new Error('Only nullable type unions are supported.');
        s = { ...s, type: s.type.find((t) => t !== 'null') };
        nullable = true;
      }
      if (s.format !== undefined && s.type !== 'string')
        throw new Error('Formats are supported only on strings.');
      let type: Field['type'];
      let options: Field['options'];
      if (s.type === 'string') {
        if (s.enum) {
          if (!Array.isArray(s.enum) || s.enum.some((v) => typeof v !== 'string'))
            throw new Error('Choice values must be strings.');
          type = 'select';
          options = s.enum.map((v) => ({ value: v as string, label: v as string }));
        } else if (s.format === 'date') type = 'date';
        else if (s.format === undefined) type = 'text';
        else throw new Error(`Unsupported string format: ${s.format}.`);
      } else if (s.type === 'boolean') type = 'boolean';
      else if (s.type === 'number' || s.type === 'integer') type = 'number';
      else if (s.type === 'array') {
        const items = resolve(s.items);
        allowed(items, ['type', 'enum', 'format']);
        if (s['x-herald-type'] === 'file' && items.type === 'string' && items.format === 'uuid')
          type = 'file';
        else {
          if (
            items.type !== 'string' ||
            !Array.isArray(items.enum) ||
            items.enum.some((v) => typeof v !== 'string') ||
            items.format
          )
            throw new Error('Arrays require string enum items, or uploaded file UUIDs.');
          type = 'multiselect';
          options = items.enum.map((v) => ({ value: v as string, label: v as string }));
        }
      } else throw new Error('Nested objects and this property type are not supported.');
      if (s['x-herald-type'] !== undefined) {
        const custom = s['x-herald-type'];
        if (type === 'text' && (custom === 'textarea' || custom === 'secret')) type = custom;
        else if (!(type === 'file' && custom === 'file')) throw new Error('Invalid x-herald-type.');
      }
      if (s.enum !== undefined && type !== 'select')
        throw new Error('Enums are supported only on strings.');
      if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].some((k) => k in s))
        if (type !== 'number') throw new Error('Numeric bounds need a numeric field.');
      if (s.minLength !== undefined || s.maxLength !== undefined)
        if (!['text', 'textarea', 'secret', 'date', 'select'].includes(type))
          throw new Error('Text bounds need a string field.');
      if (
        s.minItems !== undefined ||
        s.maxItems !== undefined ||
        s.uniqueItems !== undefined ||
        s.items !== undefined
      )
        if (!['multiselect', 'file'].includes(type))
          throw new Error('Array constraints need an array field.');
      return {
        id,
        label: s.title || id,
        help: s.description,
        type,
        options,
        required: required.includes(id),
        nullable,
        integer: s.type === 'integer',
        default: s.default,
        minimum: s.minimum,
        maximum: s.maximum,
        exclusiveMinimum: s.exclusiveMinimum,
        exclusiveMaximum: s.exclusiveMaximum,
        minLength: s.minLength,
        maxLength: s.maxLength,
        minItems: s.minItems,
        maxItems: s.maxItems,
        uniqueItems: s.uniqueItems,
      };
    }),
  );
}
