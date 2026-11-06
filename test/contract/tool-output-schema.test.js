// test/contract/tool-output-schema.test.js — tool results must match the
// schema the tool declares.
//
// The Host validates a tool's structured result against the tool's declared
// output schema, and the schemas here use `additionalProperties: false` on
// the nested objects. A producer that grows a field without declaring it
// makes the Host reject the WHOLE result.
//
// This happened in 2.4.3: the X adapter's doctor row carries `optIn`, the
// `web_doctor` output schema did not declare it, and every `web_doctor`
// call in a 2.4.3 host failed with an invalid-output error. The guard
// below would have caught it before release.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProbe } from '../../lib/doctor/probe.js'
import { OUTPUT as DOCTOR_OUTPUT } from '../../lib/tools/web-doctor.js'
import { schemaViolations } from '../helpers/schema-check.js'

function makeStubCtx() {
  return {
    session: { id: 'session-test' },
    get(key) {
      if (key === 'agents') return { currentInitiator() { return { sessionId: 'session-test' } } }
      if (key === 'settings') {
        return {
          get(ns) {
            if (ns === 'web-access-chain') {
              return {
                sourceCheck: { enabled: true },
                adapters: {
                  github: { enabled: true },
                  youtube: { enabled: true },
                  rss: { enabled: true },
                  pdf: { enabled: true },
                  genericHtml: { enabled: true },
                  x: { enabled: true },
                },
              }
            }
            return null
          },
        }
      }
      if (key === 'agentDefaultModel') return { currentSelection() { return { provider: 'test', model: 'test-model' } } }
      return null
    },
  }
}

test('the doctor report matches the schema web_doctor declares', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const report = await probe.run({})
  const violations = schemaViolations(report, DOCTOR_OUTPUT.schema, 'web_doctor')
  assert.deepEqual(violations, [],
    `the doctor report must satisfy the tool's declared output schema:\n  - ${violations.join('\n  - ')}`)
})

test('the doctor report still matches the schema in active-probe mode', async () => {
  const probe = createProbe(makeStubCtx(), null)
  const report = await probe.run({ activeProbe: true })
  const violations = schemaViolations(report, DOCTOR_OUTPUT.schema, 'web_doctor(active)')
  assert.deepEqual(violations, [],
    `the doctor report must satisfy the tool's declared output schema:\n  - ${violations.join('\n  - ')}`)
})

test('the X adapter row is declared in the schema (the 2.4.3 regression)', () => {
  const adapterProps = DOCTOR_OUTPUT.schema.properties.adapters.items.properties
  assert.ok(Object.hasOwn(adapterProps, 'optIn'),
    'the adapters schema must declare `optIn` — the X adapter row carries it')
})
