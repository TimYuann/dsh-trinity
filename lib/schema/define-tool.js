// lib/schema/define-tool.js — local defineTool shim.
//
// Reimplements the minimal subset of @deepseek-ai/dsh-tools `defineTool` we
// need: ParameterSchemaSpec → JSON Schema + ValueSchemaSpec → JSON Schema +
// args validation. The dsh-tools npm package drags in
// @deepseek-ai/dsh-type-meta (404), so we keep the dependency surface
// minimal and rely on direct calls into ctx.tools.register().
//
// v2.2: added `oneOf` support. The host validates registered tool schemas
// against its own JSON Schema node grammar (JsonSchemaType is
// object/array/string/number/integer/boolean/null — NO 'json'), so
// union-typed parameters must be expressed as `oneOf`, never `type: 'json'`
// (that fails registration with "json is not valid under any of the
// schemas listed in the 'anyOf' keyword").

const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/**
 * Compile one ParameterSchemaSpec property into a JSON Schema fragment.
 *
 * @param {any} spec
 * @param {string} key
 * @returns {{ schema: any, required: boolean }}
 */
function compileParameterProperty(spec, key) {
  if (!spec || typeof spec !== 'object') {
    throw new Error(`defineTool: parameter '${key}' must be an object`)
  }
  if (typeof spec.type !== 'string' && !Array.isArray(spec.enum) && !Array.isArray(spec.oneOf)) {
    throw new Error(`defineTool: parameter '${key}' must declare 'type' (or 'enum' / 'oneOf')`)
  }
  const required = spec.required === true
  const out = {}
  if (typeof spec.type === 'string') out.type = spec.type
  if (typeof spec.description === 'string') out.description = spec.description
  if (Array.isArray(spec.enum)) out.enum = spec.enum
  if (Array.isArray(spec.oneOf)) out.oneOf = spec.oneOf.map((it, i) => compileValueNode(it, key + '.oneOf.' + i))
  if (spec.default !== undefined) out.default = spec.default
  if (Array.isArray(spec.items)) {
    // tuple
    out.items = spec.items.map((it, i) => compileValueNode(it, key + '.items.' + i))
  } else if (spec.items) {
    out.items = compileValueNode(spec.items, key + '.items')
  }
  if (spec.minimum !== undefined) out.minimum = spec.minimum
  if (spec.maximum !== undefined) out.maximum = spec.maximum
  if (spec.minLength !== undefined) out.minLength = spec.minLength
  if (spec.maxLength !== undefined) out.maxLength = spec.maxLength
  if (spec.pattern) out.pattern = String(spec.pattern)
  return { schema: out, required }
}

/**
 * Compile one ValueSchemaSpec node into a raw JSON Schema node.
 *
 * @param {any} node
 * @param {string} path
 */
function compileValueNode(node, path) {
  if (!node || typeof node !== 'object') {
    throw new Error(`defineTool: schema node at ${path} must be an object`)
  }
  if (Array.isArray(node.oneOf)) {
    // Union node — no `type`; each branch compiles independently.
    return { oneOf: node.oneOf.map((it, i) => compileValueNode(it, path + '.oneOf.' + i)) }
  }
  if (!PRIMITIVE_TYPES.has(node.type) && node.type !== 'object' && node.type !== 'array') {
    throw new Error(`defineTool: schema node at ${path} has unsupported type ${node.type}`)
  }
  const out = { type: node.type }
  if (typeof node.description === 'string') out.description = node.description
  if (Array.isArray(node.enum)) out.enum = node.enum
  if (node.default !== undefined) out.default = node.default
  if (node.type === 'array') {
    // DSH JsonSchema validator rejects `items: { type: 'json' }` — `json` is
    // not in its allowed type set (object/array/string/number/integer/
    // boolean/null). Omit `items` entirely when the caller doesn't specify
    // it; DSH treats that as "any items allowed", which matches the original
    // intent of "untyped array".
    if (node.items) out.items = compileValueNode(node.items, path + '.items')
  }
  if (node.type === 'object') {
    if (node.properties) {
      out.properties = {}
      for (const [k, v] of Object.entries(node.properties)) {
        out.properties[k] = compileValueNode(v, path + '.properties.' + k)
      }
    }
    if (typeof node.additionalProperties === 'boolean') {
      out.additionalProperties = node.additionalProperties
    } else if (node.properties && Object.keys(node.properties).length > 0) {
      // v2.2 contract: declared-property objects stay strict by default so
      // undeclared output fields never reach the host validator.
      out.additionalProperties = false
    }
    // v2.2.1: an object node with NO properties and no explicit
    // additionalProperties is a free-form object (e.g. web_doctor's
    // `lastPing: { type: 'object' }`). Leaving the keyword out means "any
    // fields allowed" — the host validator accepts missing additionalProperties
    // and only rejects undeclared fields when it is explicitly false. The
    // previous unconditional `additionalProperties: false` compiled free-form
    // objects into empty strict shells, so every inner field (lastPing.status,
    // .latencyMs, ...) was rejected as "not a declared property".
    if (Array.isArray(node.required)) out.required = node.required
  }
  if (node.minimum !== undefined) out.minimum = node.minimum
  if (node.maximum !== undefined) out.maximum = node.maximum
  if (node.minLength !== undefined) out.minLength = node.minLength
  if (node.maxLength !== undefined) out.maxLength = node.maxLength
  return out
}

/**
 * Compile ParameterSchemaSpec (object map) to JSON Schema.
 *
 * @param {Record<string, any>} spec
 */
function compileParameters(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('defineTool: parameters must be an object map')
  }
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(spec)) {
    const { schema, required: isRequired } = compileParameterProperty(v, k)
    properties[k] = schema
    if (isRequired) required.push(k)
  }
  const out = {
    type: 'object',
    properties,
    additionalProperties: false,
  }
  if (required.length > 0) out.required = required
  return out
}

/**
 * Validate args against the compiled parameters schema. Returns an array
 * of violation strings (empty when valid).
 *
 * @param {any} schema
 * @param {unknown} args
 */
function validateArgs(schema, args) {
  const violations = []
  if (!schema || schema.type !== 'object') return violations
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    violations.push('arguments must be an object')
    return violations
  }
  const required = schema.required || []
  for (const key of required) {
    if (!(key in args)) violations.push(`arguments.${key} is required`)
  }
  for (const [k, v] of Object.entries(args)) {
    if (!(k in schema.properties)) {
      if (schema.additionalProperties === false) {
        violations.push(`arguments.${k} is not in schema`)
      }
      continue
    }
    const propSchema = schema.properties[k]
    if (propSchema.type === 'string' && typeof v !== 'string') violations.push(`arguments.${k} must be string`)
    else if (propSchema.type === 'integer' && (!Number.isInteger(v))) violations.push(`arguments.${k} must be integer`)
    else if (propSchema.type === 'number' && typeof v !== 'number') violations.push(`arguments.${k} must be number`)
    else if (propSchema.type === 'boolean' && typeof v !== 'boolean') violations.push(`arguments.${k} must be boolean`)
    else if (propSchema.type === 'array' && !Array.isArray(v)) violations.push(`arguments.${k} must be array`)
    else if (propSchema.type === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) violations.push(`arguments.${k} must be object`)
    if (propSchema.enum && Array.isArray(propSchema.enum) && !propSchema.enum.includes(v)) {
      violations.push(`arguments.${k} must be one of ${propSchema.enum.join('|')}`)
    }
    if (propSchema.type === 'string' && typeof v === 'string') {
      if (propSchema.minLength !== undefined && v.length < propSchema.minLength) {
        violations.push(`arguments.${k} must be at least ${propSchema.minLength} chars`)
      }
      if (propSchema.maxLength !== undefined && v.length > propSchema.maxLength) {
        violations.push(`arguments.${k} must be at most ${propSchema.maxLength} chars`)
      }
    }
    if (propSchema.type === 'integer' && Number.isInteger(v)) {
      if (propSchema.minimum !== undefined && v < propSchema.minimum) {
        violations.push(`arguments.${k} must be >= ${propSchema.minimum}`)
      }
      if (propSchema.maximum !== undefined && v > propSchema.maximum) {
        violations.push(`arguments.${k} must be <= ${propSchema.maximum}`)
      }
    }
  }
  return violations
}

/**
 * Local defineTool shim. Returns a ToolDefinition object that
 * `ctx.tools.register()` accepts (matches `defineTool` output shape).
 *
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, any>,
 *   output: { schema: any, render: (args: any, value: any) => any[], presentationMeta?: (args: any, value: any) => any },
 *   timeoutMs?: number,
 *   isConcurrencySafe?: (args: any) => boolean,
 *   presentCall?: (args: any) => any,
 *   presentResult?: (args: any, result: any) => any,
 *   finalizeContent?: (exec: any, result: any) => any,
 * }} options
 */
export function defineTool(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool: options required')
  const parameters = compileParameters(options.parameters || {})
  const outputSchema = compileValueNode(options.output && options.output.schema, 'output.schema')
  const userRender = options.output && options.output.render
  const userPresentationMeta = options.output && options.output.presentationMeta
  if (typeof userRender !== 'function') {
    throw new Error(`defineTool(${options.name}): output.render must be a function`)
  }
  const tool = {
    name: options.name,
    description: options.description || '',
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) { return userRender(args, value) },
      ...(typeof userPresentationMeta === 'function' ? { presentationMeta(args, value) { return userPresentationMeta(args, value) } } : {}),
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) {
        const e = new Error(`ToolArgsError: ${violations.join('; ')}`)
        e.violations = violations
        throw e
      }
      return options.execute(args, exec)
    },
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (typeof options.finalizeContent === 'function') tool.finalizeContent = (e, r) => options.finalizeContent(e, r)
  if (typeof options.presentCall === 'function') tool.presentCall = (a) => options.presentCall(a)
  if (typeof options.presentResult === 'function') tool.presentResult = (a, r) => options.presentResult(a, r)
  if (typeof options.isConcurrencySafe === 'function') tool.isConcurrencySafe = (a) => options.isConcurrencySafe(a) === true
  return tool
}