const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const users = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'users_config.json'),
  'utf8'
));

test('saved users use company as the sole NVIDIA account-name property', () => {
  assert.ok(users.length > 0);
  assert.equal(users.every(user => typeof user.testCompany === 'string' && user.testCompany.length > 0), true);
  assert.equal(users.some(user => Object.prototype.hasOwnProperty.call(user, 'testCloudAccount')), false);
});
