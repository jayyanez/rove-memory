/**
 * The few `expect` matchers the suites use, over node:assert, so the tests run
 * on Node's own test runner with no dependency. The suites came from a vitest
 * codebase; keeping their assertions as written keeps them comparable.
 */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const ASYMMETRIC = Symbol('asymmetric matcher');

function asymmetric(describe, test) {
  return { [ASYMMETRIC]: true, describe, test };
}

function isAsymmetric(value) {
  return Boolean(value && typeof value === 'object' && value[ASYMMETRIC]);
}

/** Whether `actual` contains every property of `expected`, recursively. */
function matchesObject(actual, expected) {
  if (isAsymmetric(expected)) return expected.test(actual);
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((item, index) => matchesObject(actual[index], item));
  }
  return Object.keys(expected).every((key) => key in actual && matchesObject(actual[key], expected[key]));
}

function textMatches(actual, pattern) {
  return typeof pattern === 'string' ? actual.includes(pattern) : pattern.test(actual);
}

function thrown(callback) {
  try {
    callback();
  } catch (error) {
    return { error };
  }
  return null;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export function expect(actual) {
  return {
    toBe(expected) {
      assert.ok(Object.is(actual, expected), `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toMatch(pattern) {
      assert.equal(typeof actual, 'string', `expected a string, got ${typeof actual}`);
      assert.ok(textMatches(actual, pattern), `expected ${JSON.stringify(actual)} to match ${pattern}`);
    },
    toMatchObject(expected) {
      assert.ok(matchesObject(actual, expected), `expected ${JSON.stringify(actual)} to match object ${JSON.stringify(expected)}`);
    },
    toBeNull() {
      assert.equal(actual, null);
    },
    toBeTruthy() {
      assert.ok(actual, `expected ${JSON.stringify(actual)} to be truthy`);
    },
    toThrow(pattern) {
      const result = thrown(actual);
      assert.ok(result, 'expected the callback to throw');
      if (pattern !== undefined) {
        const message = messageOf(result.error);
        assert.ok(textMatches(message, pattern), `expected the error ${JSON.stringify(message)} to match ${pattern}`);
      }
    },
    not: {
      toBe(expected) {
        assert.ok(!Object.is(actual, expected), `expected ${JSON.stringify(actual)} not to be ${JSON.stringify(expected)}`);
      },
      toMatch(pattern) {
        assert.equal(typeof actual, 'string', `expected a string, got ${typeof actual}`);
        assert.ok(!textMatches(actual, pattern), `expected ${JSON.stringify(actual)} not to match ${pattern}`);
      },
      toThrow() {
        const result = thrown(actual);
        assert.ok(!result, `expected the callback not to throw, it threw: ${result ? messageOf(result.error) : ''}`);
      },
      toEqual(expected) {
        assert.ok(!isDeepStrictEqual(actual, expected), 'expected the values to differ');
      },
    },
  };
}

expect.any = (type) => asymmetric(`any ${type.name}`, (value) => (
  type === String ? typeof value === 'string'
    : type === Number ? typeof value === 'number'
      : value instanceof type
));
expect.stringMatching = (pattern) => asymmetric(`string matching ${pattern}`, (value) => (
  typeof value === 'string' && textMatches(value, pattern)
));
