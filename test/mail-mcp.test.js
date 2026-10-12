import assert from "node:assert/strict";
import { test } from "node:test";
import { autonomousMailAllowed, MAIL_OWNER_EMAIL } from "../src/mail-mcp.js";

test("autonomous email is limited to the configured owner address with no CC", () => {
  assert.equal(autonomousMailAllowed({ subject: "Hi", body: "Hello" }), true);
  assert.equal(autonomousMailAllowed({ to: MAIL_OWNER_EMAIL.toUpperCase(), subject: "Hi", body: "Hello" }), true);
  assert.equal(autonomousMailAllowed({ to: "someone@example.com", subject: "Hi", body: "Hello" }), false);
  assert.equal(autonomousMailAllowed({ to: `${MAIL_OWNER_EMAIL}, someone@example.com` }), false);
  assert.equal(autonomousMailAllowed({ cc: "someone@example.com" }), false);
});
