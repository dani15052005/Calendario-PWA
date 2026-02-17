const assert = require("assert");
const { normalizeEmail, isOwnerEmail } = require("../auth-helpers.js");

const OWNER = "andres5871@gmail.com";

assert.strictEqual(normalizeEmail("  ANDRES5871@gmail.com "), OWNER);
assert.strictEqual(isOwnerEmail("andres5871@gmail.com", OWNER), true);
assert.strictEqual(isOwnerEmail("ANDRES5871@gmail.com", OWNER), true);
assert.strictEqual(isOwnerEmail(" andres5871@gmail.com ", OWNER), true);
assert.strictEqual(isOwnerEmail("otra.persona@gmail.com", OWNER), false);

console.log("auth-helpers tests passed");
