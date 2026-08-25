import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments } from '../scripts/validate-trajectories.mjs';

test('trajectory validator accepts explicit task metadata for isolated workspaces', () => {
  const options = parseArguments(['--json', '--task-type=bugfix', '--task-name=sample', '--task-root=/tmp/task', '--max-writes=2', 'trajectory.json']);
  assert.equal(options.json, true);
  assert.equal(options.taskType, 'bugfix');
  assert.equal(options.taskName, 'sample');
  assert.equal(options.taskRoot, '/tmp/task');
  assert.equal(options.maxWrites, 2);
  assert.deepEqual(options.inputs, ['trajectory.json']);
});
