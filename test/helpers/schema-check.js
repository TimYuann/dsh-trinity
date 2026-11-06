// test/helpers/schema-check.js — a small JSON-Schema subset validator.
//
// The Host validates a tool's structured result against the tool's declared
// output schema, and the schema in this repository uses
// `additionalProperties: false` on the nested objects. A producer that
// grows a field without declaring it therefore makes the HOST reject the
// whole tool result — which is exactly what happened to `web_doctor` in
// 2.4.3 (the X adapter's row carries `optIn`).
//
// This helper validates a value against that subset: object / array /
// string / boolean / integer / number, `properties`, `items`,
// `required`, `additionalProperties: false`, and `enum`. It is not a
// general validator; it exists to catch schema drift in tests.

/**
 * @param {any} value
 * @param {any} schema
 * @param {string} path
 * @param {string[]} errors
 */
function collect(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return
  // `undefined` never reaches the Host: the tool result is materialised as
  // lossless JSON, and JSON drops undefined properties. So an undefined
  // value is an ABSENT value, not a type violation.
  if (value === undefined) return
  const type = schema.type

  if (type === 'object' || (type === undefined && schema.properties)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: expected an object, got ${Array.isArray(value) ? 'array' : typeof value}`)
      return
    }
    const props = schema.properties || {}
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue   // absent after JSON materialisation
      if (Object.hasOwn(props, key)) {
        collect(value[key], props[key], `${path}.${key}`, errors)
        continue
      }
      if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: not declared by the schema (additionalProperties: false)`)
      }
    }
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        errors.push(`${path}.${key}: required but missing`)
      }
    }
    return
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array, got ${typeof value}`)
      return
    }
    if (schema.items) {
      value.forEach((item, i) => collect(item, schema.items, `${path}[${i}]`, errors))
    }
    return
  }

  if (type === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: expected a string, got ${typeof value}`)
    return
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path}: expected a boolean, got ${typeof value}`)
    return
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path}: expected an integer, got ${typeof value}`)
    return
  }
  if (type === 'number') {
    if (typeof value !== 'number') errors.push(`${path}: expected a number, got ${typeof value}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  }
}

/**
 * @param {any} value
 * @param {any} schema
 * @param {string} [label]
 * @returns {string[]} the violations; empty means the value matches
 */
export function schemaViolations(value, schema, label = 'value') {
  const errors = []
  collect(value, schema, label, errors)
  return errors
}

/**
 * @param {any} value
 * @param {any} schema
 * @param {string} [label]
 * @returns {void} throws when the value does not match
 */
export function assertMatchesSchema(value, schema, label = 'value') {
  const errors = schemaViolations(value, schema, label)
  if (errors.length > 0) {
    throw new Error(`${label} does not match its declared schema:\n  - ${errors.join('\n  - ')}`)
  }
}
