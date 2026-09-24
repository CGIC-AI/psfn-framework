#!/usr/bin/env node
// mfr7t: case minimum tiers are a scheduling contract that fails closed.
import assert from 'node:assert/strict';
import {
  caseAdmissibleAtTier,
  casesBelowTierFloor,
  lowestAdmissibleTier,
} from '../lib/case-tier-floors.mjs';

assert.equal(caseAdmissibleAtTier('prompt_stack', 'nursery'), false);
assert.equal(caseAdmissibleAtTier('prompt_stack', 'apprentice'), true);
assert.equal(caseAdmissibleAtTier('prompt_stack', 'autonomous'), true);
assert.equal(caseAdmissibleAtTier('prompt_stack', undefined), false, 'unknown tier cannot prove the floor');
assert.equal(caseAdmissibleAtTier('l0_baseline', 'nursery'), true);
assert.equal(caseAdmissibleAtTier('l0_baseline', undefined), true, 'unfloored cases are unaffected');
assert.deepEqual(casesBelowTierFloor(['l0_baseline', 'prompt_stack'], 'nursery'), ['prompt_stack']);
assert.deepEqual(casesBelowTierFloor(['l0_baseline', 'prompt_stack'], 'apprentice'), []);
assert.equal(lowestAdmissibleTier('prompt_stack', ['autonomous', 'nursery', 'apprentice']), 'apprentice');
assert.equal(lowestAdmissibleTier('prompt_stack', ['nursery']), undefined);
assert.equal(caseAdmissibleAtTier('prompt_stack', 'overlord'), false, 'unrecognized tier cannot prove the floor');
console.log('case-tier-floors: ok');
