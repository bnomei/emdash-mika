# ACP conformance fixture

`schema.agentic_checkout.2025-09-29.json` is an unchanged copy of the Agentic
Commerce Protocol repository's initial checkout JSON Schema snapshot:

<https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/7fdd78df677a94dce04c770644b0fbbb1401272b/spec/2025-09-29/json-schema/schema.agentic_checkout.json>

That schema snapshot describes the checkout contract served with OpenAI's
`API-Version: 2025-09-12` header. Keep the schema snapshot, API header constant,
and conformance tests pinned together; upgrades should be explicit.

The vendored bytes stay unchanged and are checksum-pinned. The test validator
applies two documented mechanical corrections to the snapshot in memory:

- its draft 2020-12 declaration conflicts with a draft-04-style boolean
  `exclusiveMinimum`; the intended `quantity > 0` constraint becomes
  `exclusiveMinimum: 0`;
- `CheckoutSessionWithOrder` composes an `order` field onto a base schema whose
  `additionalProperties: false` rejects that same field; the test moves the
  closure to `unevaluatedProperties: false` on the composed session schemas.

These corrections do not change Mika's wire contract or the vendored source.
